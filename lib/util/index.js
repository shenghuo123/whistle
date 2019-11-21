var http = require('http');
var path = require('path');
var os = require('os');
var fs = require('fs');
var vm = require('vm');
var net = require('net');
var tls = require('tls');
var crypto = require('crypto');
var fse = require('fs-extra2');
var qs = require('querystring');
var extend = require('extend');
var LRU = require('lru-cache');
var PassThrough = require('stream').PassThrough;
var iconv = require('iconv-lite');
var zlib = require('zlib');
var dns = require('dns');
var PipeStream = require('pipestream');
var Q = require('q');
var Buffer = require('safe-buffer').Buffer;
var protoMgr = require('../rules/protocols');
var protocols = protoMgr.protocols;
var logger = require('./logger');
var config = require('../config');
var isUtf8 = require('./is-utf8');
var fileMgr = require('./file-mgr');
var httpMgr = require('./http-mgr');
var ReplacePatternTransform = require('./replace-pattern-transform');
var parseQuery = require('./parse-query');
var h2Consts = config.enableH2 ? require('http2').constants : {};

var fileWriterCache = {};
var CRLF_RE = /\r\n|\r|\n/g;
var SEARCH_RE = /[?#].*$/;
var UTF8_OPTIONS = {encoding: 'utf8'};
var LOCALHOST = '127.0.0.1';
var aliasProtocols = protoMgr.aliasProtocols;
var CONTEXT = vm.createContext();
var SCRIPT_BODY = 'function parse(str) {var fn = new Function("return " + str); return fn();}; parse;';
var EVAL_SCRIPT = new vm.Script(SCRIPT_BODY);
var END_WIDTH_SEP_RE = /[/\\]$/;
var JSON_RE = /^\s*(?:\{[\w\W]*\}|\[[\w\W]*\])\s*$/;
var GEN_URL_RE = /^\s*(?:https?:)?\/\/\w[^\s]*\s*$/i;
var G_NON_LATIN1_RE = /[^\x00-\xFF]/g;
var NON_LATIN1_RE = /[^\x00-\xFF]/;
var JSON_CACHE = new LRU({ max: 30 });
var SCRIPT_START = toBuffer('<script>');
var SCRIPT_END = toBuffer('</script>');
var STYLE_START = toBuffer('<style>');
var STYLE_END = toBuffer('</style>');
var JSON_VM_OPTIONS = {
  displayErrors: false,
  timeout: 60
};
var RAW_CRLF_RE = /\\n|\\r/g;
var NUM_RE = /^\d+$/;
var DIG_RE = /^-?[1-9]\d*$/;
var INDEX_RE = /^\[(\d+)\]$/;
var ARR_FILED_RE = /(.)?(?:\[(\d+)\])$/;
var UTF8_RE = /^utf-?8$/i;
var PROXY_RE = /^x?(?:socks|https?-proxy|proxy|internal(?:-https)?-proxy)$/;
var DEFAULT_REGISTRY = 'https://registry.npmjs.org';
var HTTP_RE = /^(https?:\/\/[^/?]+)/;
var ctxTimer;
var resetContext = function() {
  ctxTimer = null;
  CONTEXT = vm.createContext();
};
var SUB_MATCH_RE = /\$[&\d]/;
var replacePattern = ReplacePatternTransform.replacePattern;
var parseUrl = require('./parse-url');
// 避免属性被 stringify ，减少冗余数据传给前端
exports.PLUGIN_VALUES = typeof Symbol === 'undefined' ? '_values' : Symbol('_values'); // eslint-disable-line
exports.PLUGIN_MENU_CONFIG = typeof Symbol === 'undefined' ? '_menuConfig' : Symbol('_menuConfig'); // eslint-disable-line
exports.drain = require('./drain');
exports.isWin = process.platform === 'win32';
exports.isUtf8 = isUtf8;
exports.WhistleTransform = require('./whistle-transform');
exports.ReplacePatternTransform = ReplacePatternTransform;
exports.replacePattern = replacePattern;
exports.ReplaceStringTransform = require('./replace-string-transform');
exports.SpeedTransform = require('./speed-transform');
exports.FileWriterTransform = require('./file-writer-transform');
exports.getServer = require('hagent').getServer;
exports.parseUrl = parseUrl;
exports.request = httpMgr.request;
exports.parseQuery = parseQuery;
exports.listenerCount = require('./patch').listenerCount;

function noop(_) {
  return _;
}

exports.noop = noop;

function wrapJs(js, charset, isUrl) {
  if (!js) {
    return '';
  }
  if (isUrl) {
    return toBuffer('<script src="' + js + '"></script>', charset);
  }
  return Buffer.concat([SCRIPT_START, toBuffer(js, charset), SCRIPT_END]);
}

function wrapCss(css, charset, isUrl) {
  if (!css) {
    return '';
  }
  if (isUrl) {
    return toBuffer('<link rel="stylesheet" href="' + css + '" />', charset);
  }
  return Buffer.concat([STYLE_START, toBuffer(css, charset), STYLE_END]);
}

function evalJson(str) {
  if (!JSON_RE.test(str)) {
    return;
  }
  var result = JSON_CACHE.get(str);
  if (result) {
    return result;
  }
  try {
    var parse = EVAL_SCRIPT.runInContext(CONTEXT, JSON_VM_OPTIONS);
    result = parse(str);
    JSON_CACHE.set(str, result);
    return result;
  } catch(e) {} finally {
    clearContext();
  }
}

exports.parseRawJson = function(str) {
  try {
    return JSON.parse(str);
  } catch(e) {
    return evalJson(str);
  }
};

function getRegistry(pkg) {
  var resolved = pkg._resolved;
  if (!resolved || !HTTP_RE.test(resolved)) {
    return;
  }
  resolved = RegExp.$1;
  return resolved === DEFAULT_REGISTRY ? undefined : resolved;
}

var MAX_LEN = 1024 * 1024 * 5;

function getLatestVersion(registry, cb) {
  if (registry && typeof registry !== 'string') {
    var name = registry.moduleName;
    registry = registry.registry;
    if (registry) {
      registry += '/' + name;
    }
  }
  if (!registry) {
    return cb();
  }
  httpMgr.request({
    url: registry,
    maxLength: MAX_LEN
  }, function(err, body, res) {
    if (err || res.statusCode !== 200) {
      body = null;
    } else if (body) {
      body = parseJSON(body);
    }
    body = body && body['dist-tags'];
    cb(body && body['latest']);
  });
}

exports.getRegistry = getRegistry;
exports.getLatestVersion = getLatestVersion;

var ESTABLISHED_CTN = 'HTTP/1.1 200 Connection Established\r\nProxy-Agent: ' + config.name + '\r\n\r\n';
exports.setEstablished = function(socket) {
  socket.write(ESTABLISHED_CTN);
};

function changePort(url, port) {
  var index = url.indexOf('/', url.indexOf('://') + 3);
  if (index != -1) {
    var host = url.substring(0, index).replace(/:\d*$/, '');
    url = host + ':' + port + url.substring(index);
  }
  return url;
}

exports.changePort = changePort;

function handleStatusCode(statusCode, headers) {
  if (statusCode == 401) {
    headers['www-authenticate'] = 'Basic realm=User Login';
  }
  return headers;
}

exports.handleStatusCode = handleStatusCode;

function getStatusCode(statusCode) {
  statusCode |= 0;
  return (statusCode < 100 || statusCode > 999) ? 0 : statusCode;
}

exports.getStatusCode = getStatusCode;

var scriptCache = {};
var VM_OPTIONS = {
  displayErrors: false,
  timeout: 60
};
var MAX_SCRIPT_SIZE = 1024 * 256;
var MAX_SCRIPT_CACHE_COUNT = 64;
var MIN_SCRIPT_CACHE_COUNT = 32;

function getScript(content) {
  content = content.trim();
  var len = content.length;
  if (!len || len > MAX_SCRIPT_SIZE) {
    return;
  }

  var script = scriptCache[content];
  delete scriptCache[content];

  var list = Object.keys(scriptCache);
  if (list.length > MAX_SCRIPT_CACHE_COUNT) {
    list = list.map(function(content) {
      var script = scriptCache[content];
      script.content = content;
      return script;
    }).sort(function(a, b) {
      return a.time > b.time ? -1 : 1;
    }).splice(0, MIN_SCRIPT_CACHE_COUNT);

    scriptCache = {};
    list.forEach(function(script) {
      scriptCache[script.content] = {
        script: script.script,
        time: script.time
      };
    });
  }

  script = scriptCache[content] = script || {
    script: new vm.Script('(function(){\n' + content + '\n})()')
  };
  script.time = Date.now();

  return script.script;
}

function clearContext() {
  Object.keys(CONTEXT).forEach(function(key) {
    delete CONTEXT[key];
  });
  if (!ctxTimer) {
    ctxTimer = setTimeout(resetContext, 30000);
  }
}

function execScriptSync(script, context) {
  try {
    if (script = getScript(script)) {
      CONTEXT.console = {};
      ['fatal', 'error', 'warn', 'info', 'log', 'debug']
        .forEach(function(level) {
          CONTEXT.console[level] = logger[level];
        });
      Object.keys(context).forEach(function(key) {
        CONTEXT[key] = context[key];
      });
      script.runInContext(CONTEXT, VM_OPTIONS);
    }
    return true;
  } catch(e) {
    logger.error(e);
  } finally {
    clearContext();
  }
}

exports.execScriptSync = execScriptSync;

function getFileWriter(file, callback) {
  if (!file || fileWriterCache[file]) {
    return callback();
  }

  var execCallback = function(writer) {
    delete fileWriterCache[file];
    callback(writer);
  };

  fs.stat(file, function(err, stat) {
    if (!err) {
      return execCallback();
    }
    logger.warn(err);
    fse.ensureFile(file, function(err) {
      execCallback(err ? null : fs.createWriteStream(file).on('error', logger.error));
      logger.error(err);
    });
  });
}

exports.getFileWriter = getFileWriter;

function getFileWriters(files, callback) {
  if (!Array.isArray(files)) {
    files = [files];
  }

  Q.all(files.map(function(file) {
    var defer = Q.defer();
    getFileWriter(file, function(writer) {
      defer.resolve(writer);
    });
    return defer.promise;
  })).spread(callback);
}

exports.getFileWriters = getFileWriters;

function toBuffer(buf, charset) {
  if (buf == null || Buffer.isBuffer(buf)) {
    return buf;
  }
  buf += '';
  if (charset && typeof charset === 'string' && !UTF8_RE.test(charset)) {
    try {
      charset = charset.toLowerCase();
      if (charset === 'base64') {
        return Buffer.from(buf, 'base64');
      }
      return iconv.encode(buf, charset);
    } catch (e) {}
  }
  return Buffer.from(buf);
}

exports.toBuffer = toBuffer;

function getErrorStack(err) {
  if (!err) {
    return '';
  }

  var stack;
  try {
    stack = err.stack;
  } catch(e) {}
  stack = stack || err.message || err;
  var result = [
    'From: ' + config.name + '@' + config.version,
    'Node: ' + process.version,
    'Date: ' + formatDate(),
    stack];
  return result.join('\r\n');
}

exports.getErrorStack = getErrorStack;

function formatDate(now) {
  now = now || new Date();
  return now.toLocaleString();
}

exports.formatDate = formatDate;

var REG_EXP_RE = /^\/(.+)\/(i)?$/;

exports.isRegExp = function isRegExp(regExp) {
  return REG_EXP_RE.test(regExp);
};

var ORIG_REG_EXP = /^\/(.+)\/([igm]{0,3})$/;

function isOriginalRegExp(regExp) {
  if (!ORIG_REG_EXP.test(regExp) || /[igm]{2}/.test(regExp.$2)) {
    return false;
  }

  return true;
}
exports.isOriginalRegExp = isOriginalRegExp;

function toOriginalRegExp(regExp) {
  regExp = ORIG_REG_EXP.test(regExp);
  try {
    regExp = regExp && new RegExp(RegExp.$1, RegExp.$2);
  } catch(e) {
    regExp = null;
  }
  return regExp;
}
exports.toOriginalRegExp = toOriginalRegExp;

exports.emitError = function(obj, err) {
  if (obj) {
    obj.once('error', noop);
    obj.emit('error', err || new Error('Unknown'));
  }
};

exports.indexOfList = function(buf, subBuf, start) {
  start = start || 0;
  if (buf.indexOf) {
    return buf.indexOf(subBuf, start);
  }

  var subLen = subBuf.length;
  if (subLen) {
    for (var i = start, len = buf.length - subLen; i <= len; i++) {
      var j = 0;
      for (; j < subLen; j++) {
        if (subBuf[j] !== buf[i + j]) {
          break;
        }
      }
      if (j == subLen) {
        return i;
      }
    }
  }

  return -1;
};

exports.startWithList = function(buf, subBuf, start) {
  var len = subBuf.length;
  if (!len) {
    return false;
  }

  start = start || 0;
  for (var i = 0; i < len; i++) {
    if (buf[i + start] != subBuf[i]) {
      return false;
    }
  }

  return true;
};

exports.endWithList = function(buf, subBuf, end) {
  var subLen = subBuf.length;
  if (!subLen) {
    return false;
  }
  if (!(end >= 0)) {
    end = buf.length - 1;
  }

  for (var i = 0; i < subLen; i++) {
    if (subBuf[subLen - i - 1] != buf[end - i]) {
      return false;
    }
  }

  return true;
};

function isEnable(req, name) {
  return req.enable[name] && !req.disable[name];
}

exports.isEnable = isEnable;

exports.toRegExp = function toRegExp(regExp, ignoreCase) {
  regExp = REG_EXP_RE.test(regExp);
  try {
    regExp = regExp && new RegExp(RegExp.$1, ignoreCase ? 'i' : RegExp.$2);
  } catch(e) {
    regExp = null;
  }
  return regExp;
};

var HTTP_PORT_RE = /:80$/;
var HTTPS_PORT_RE = /:443$/;

function removeDefaultPort(host, isHttps) {
  return host && host.replace(isHttps ? HTTPS_PORT_RE : HTTP_PORT_RE, '');
}

function getFullUrl(req) {
  var headers = req.headers;
  var hostRule;
  var host = headers['x-whistle-real-host'] || headers['x-forwarded-host'];
  if (host) {
    delete headers['x-whistle-real-host'];
    delete headers['x-forwarded-host'];
  }
  if (!host || typeof host !== 'string') {
    host = headers.host;
  } else {
    hostRule = false;
    headers.host = host;
  }
  if (hasProtocol(req.url)) {
    var options = parseUrl(req.url);
    if (options.protocol === 'https:') {
      req.isHttps = true;
    }
    req.url = options.path;
    if (options.host) {
      if (!host || typeof host !== 'string') {
        host = headers.host = options.host;
      } else if (hostRule !== false && host != options.host) {
        hostRule = options.host;
      }
    }
  } else {
    req.url = req.url || '/';
    if (req.url[0] !== '/') {
      req.url = '/' + req.url;
    }
    if (typeof host !== 'string') {
      host = headers.host = '';
    }
  }
  host = removeDefaultPort(host, req.isHttps);
  var fullUrl = _getProtocol(req.isHttps) + host + req.url;
  if (hostRule && removeDefaultPort(hostRule, req.isHttps) != host) {
    headers['x-whistle-rule-host'] = safeEncodeURIComponent(fullUrl + ' host://' + hostRule + ' enable://proxyHost');
  }
  return fullUrl;
}
exports.getFullUrl = getFullUrl;

function setProtocol(url, isHttps) {
  return hasProtocol(url) ? url : _getProtocol(isHttps) + url;
}

function _getProtocol(isHttps) {
  return isHttps ? 'https://' : 'http://';
}

function hasProtocol(url) {
  return /^[a-z0-9.-]+:\/\//i.test(url);
}

function getProtocol(url) {
  return hasProtocol(url) ? url.substring(0, url.indexOf('://') + 1) : null;
}

function removeProtocol(url, clear) {
  return hasProtocol(url) ? url.substring(url.indexOf('://') + (clear ? 3 : 1)) : url;
}

function replaceProtocol(url, protocol) {

  return (protocol || 'http:') +  removeProtocol(url);
}

exports.hasProtocol = hasProtocol;
exports.setProtocol = setProtocol;
exports.getProtocol = getProtocol;
exports.removeProtocol = removeProtocol;
exports.replaceProtocol = replaceProtocol;

function disableCSP(headers) {
  delete headers['content-security-policy'];
  delete headers['content-security-policy-report-only'];
  delete headers['x-content-security-policy'];
  delete headers['x-content-security-policy-report-only'];
  delete headers['x-webkit-csp'];
}

exports.disableCSP = disableCSP;

var interfaces = os.networkInterfaces();
var hostname = os.hostname();
var cpus = os.cpus();
var addressList = [];
var updateSystyemInfo;

var clientId = [hostname, os.platform(), os.release(),
  os.arch(), cpus.length, cpus[0] && cpus[0].model, config.clientId];
clientId = config.clientId = crypto.createHmac('sha256', config.CLIENT_ID_HEADER)
  .update(clientId.join('\r\n')).digest('hex');
config.runtimeId = crypto.createHmac('sha256', config.CLIENT_ID_HEADER)
  .update(clientId + '\r\n' + Math.random() + '\r\n' + Date.now())
  .digest('hex') + '/' + config.port;
config.runtimeHeaders = { 'x-whistle-runtime-id': config.runtimeId };

exports.setClientId = function(headers, enable, disable, clientIp) {
  if (disable && (disable.clientId || disable.clientID || disable.clientid)) {
    return;
  }
  if (enable && (enable.clientId || enable.clientID || enable.clientid)) {
    var id = clientId;
    if (enable.multiClient && !enable.singleClient && !disable.multiClient) {
      if (headers[config.CLIENT_ID_HEADER]) {
        return;
      }
      if (!isLocalAddress(clientIp)) {
        id += '/' + clientIp;
      }
    }
    headers[config.CLIENT_ID_HEADER] = id;
  }
};

exports.removeClientId = function(headers) {
  delete headers[config.CLIENT_ID_HEADER];
};

function networkInterfaces() {
  if (!updateSystyemInfo) {
    updateSystyemInfo = function () {
      interfaces = os.networkInterfaces();
      hostname = os.hostname();
      addressList = [];
      for (var i in interfaces) {
        var list = interfaces[i];
        if (Array.isArray(list)) {
          list.forEach(function(info) {
            addressList.push(info.address.toLowerCase());
          });
        }
      }
      setTimeout(updateSystyemInfo, 30000);
    };
    setTimeout(updateSystyemInfo, 30000);
  }
  return interfaces;
}

function getHostname() {
  return hostname;
}

exports.networkInterfaces = networkInterfaces;
exports.hostname = getHostname;

function isLocalAddress(address) {
  if (isLocalIp(address)) {
    return true;
  }
  if (address == '0:0:0:0:0:0:0:1') {
    return true;
  }
  address = address.toLowerCase();
  if (address[0] === '[') {
    address = address.slice(1, -1);
  }
  return addressList.indexOf(address) !== -1;
}

exports.isLocalAddress = isLocalAddress;

function isLocalHost(host) {
  return host === 'localhost' || isLocalAddress(host);
}

exports.isLocalHost = isLocalHost;

function parseHost(host) {
  if (host[0] === '[') {
    var index = host.indexOf(']');
    host = [host.substring(1, index), host.substring(index + 2)];
  } else {
    host = host.split(':');
  }
  return host;
}

exports.parseHost = parseHost;

/**
* 解析一些字符时，encodeURIComponent可能会抛异常，对这种字符不做任何处理
* see: http://stackoverflow.com/questions/16868415/encodeuricomponent-throws-an-exception
* @param ch
* @returns
*/
function safeEncodeURIComponent(ch) {
  try {
    return encodeURIComponent(ch);
  } catch(e) {}

  return ch;
}

exports.encodeNonLatin1Char = function(str) {
  if (!str || typeof str != 'string') {
    return '';
  }
  return str.replace(G_NON_LATIN1_RE, safeEncodeURIComponent);
};

exports.encodeURIComponent = safeEncodeURIComponent;

function getPath(url, noProtocol) {
  if (url) {
    url = url.replace(SEARCH_RE, '');
    var index = noProtocol ? -1 : url.indexOf('://');
    url = index > -1 ? url.substring(index + 3) : url;
  }

  return url;
}

exports.getPath = getPath;

function getFilename(url) {
  if (typeof url == 'string' && (url = getPath(url).trim())) {
    var index = url.lastIndexOf('/');
    if (index != -1) {
      url = url.substring(index + 1);
    } else {
      url = null;
    }
  } else {
    url = null;
  }

  return url || 'index.html';
}

exports.getFilename = getFilename;

function disableReqCache(headers) {
  delete headers['if-modified-since'];
  delete headers['if-none-match'];
  delete headers['last-modified'];
  delete headers.etag;

  headers['pragma'] = 'no-cache';
  headers['cache-control'] = 'no-cache';
}

exports.disableReqCache = disableReqCache;

function disableResStore(headers) {
  headers['cache-control'] = 'no-store';
  headers['expires'] = new Date(Date.now() - 60000000).toGMTString();
  headers['pragma'] = 'no-cache';
  delete headers.tag;
}

exports.disableResStore = disableResStore;

function parsePathReplace(urlPath, params) {
  if (!params || !/^(?:ws|http)s?:/.test(urlPath)) {
    return;
  }
  var index = urlPath.indexOf('://');
  if (index == -1) {
    return;
  }
  index = urlPath.indexOf('/', index + 3) + 1;
  if (index <= 0) {
    return;
  }

  var root = urlPath.substring(0, index);
  urlPath = urlPath.substring(index);

  Object.keys(params).forEach(function(pattern) {
    var value = params[pattern];
    value = value == null ? '' : value + '';
    if (isOriginalRegExp(pattern) && (pattern = toOriginalRegExp(pattern))) {
      urlPath = urlPath.replace(pattern, value);
    } else if (pattern) {
      urlPath = urlPath.split(pattern).join(value);
    }
  });
  root += urlPath;
  return root !== urlPath ? root : null;
}

exports.parsePathReplace = parsePathReplace;

function wrapResponse(res) {
  var passThrough = new PassThrough();
  passThrough.statusCode = res.statusCode;
  passThrough.rawHeaderNames = res.rawHeaderNames;
  passThrough.headers = lowerCaseify(res.headers);
  passThrough.trailers = lowerCaseify(res.trailers);
  passThrough.headers.server = config.name;
  res.body != null && passThrough.push(Buffer.isBuffer(res.body) ? res.body : String(res.body));
  passThrough.push(null);
  return passThrough;
}

exports.wrapResponse = wrapResponse;

function wrapGatewayError(body) {
  return wrapResponse({
    statusCode: 502,
    headers: {
      'content-type': 'text/html; charset=utf8'
    },
    body: body ? '<pre>\n' + body + '\n\n\n<a href="javascript:;" onclick="location.reload()"'
      + '>Reload this page</a>\n</pre>' : ''
  });
}

exports.wrapGatewayError = wrapGatewayError;

function sendStatusCodeError(cltRes, svrRes) {
  delete svrRes.headers['content-length'];
  cltRes.writeHead(502, svrRes.headers);
  cltRes.src(wrapGatewayError('Invalid status code: ' + svrRes.statusCode));
}
exports.sendStatusCodeError = sendStatusCodeError;
exports.getQueryValue = function(value) {
  if (value && typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch(e) {}
  }
  return value || '';
};

function parseInlineJSON(text, isValue) {
  if (/\s/.test(text) || (!isValue && (/\\|\//.test(text) && !/^&/.test(text)))) {
    return;
  }
  return parseQuery(text);
}

function replaceCrLf(char) {
  return char === '\\r' ? '\r' : '\n';
}

function parseLinesJSON(text) {
  if (!text || typeof text != 'string' || !(text = text.trim())) {
    return null;
  }
  var first = text[0];
  var last = text[text.length - 1];
  if ((first === '[' && last === ']') || (first === '{' && last === '}')) {
    return null;
  }
  var result;
  text.split(/\r\n|\n|\r/g).forEach(function(line) {
    if (!(line = line.trim())) {
      return;
    }
    var index = line.indexOf(': ');
    if (index === -1) {
      index = line.indexOf(':');
    }
    var name, value, arrIndex;
    if (index != -1) {
      name = line.substring(0, index).trim();
      value = line.substring(index + 1).trim();
      if (value) {
        var fv = value[0];
        var lv = value[value.length - 1];
        if (fv === lv) { 
          if (fv === '"' || fv === '`') {
            value = value.slice(1, -1);
          }
          if (value && fv === '`' && (value.indexOf('\\n') !== -1 || value.indexOf('\\r') !== -1)) {
            value = value.replace(RAW_CRLF_RE, replaceCrLf);
          }
        } else if (value === '0') {
          value = 0;
        } else if (value.length < 16 && DIG_RE.test(value)) {
          try {
            value = parseInt(value, 10);
          } catch (e) {}
        }
      }
    } else {
      name = line.trim();
      value = '';
    }
    first = name[0];
    last = name[name.length - 1];
    if (first === last && last === '"') {
      name = name.slice(1, -1);
    } else if (first === '[' && last === ']') {
      name = name.slice(1, -1).trim();
      if (NUM_RE.test(name) || INDEX_RE.test(name)) {
        name = RegExp.$1 || RegExp['$&'];
        result = result || [];
      } else {
        var keys = name.split(/\s*\.\s*/);
        name = keys.shift().trim();
        if (ARR_FILED_RE.test(name)) {
          var idx = RegExp.$2;
          if (RegExp.$1) {
            name = name.slice(0, -idx.length - 2);
            arrIndex = idx;
          } else {
            name = idx;
            result = result || [];
          }
        }
        if (keys.length) {
          keys.reverse().forEach(function(key) {
            var obj;
            if (ARR_FILED_RE.test(key)) {
              var idx2 = RegExp.$2;
              var arr = [];
              if (RegExp.$1) {
                obj = {};
                obj[key.slice(0, -idx2.length - 2)] = arr;
                arr[idx2] = value;
                value = obj;
              } else {
                arr[idx2] = value;
                value = arr;
              }
            } else {
              obj = {};
              obj[key] = value;
              value = obj;
            }
          });
        }
      }
    }
    result = result || {};
    var list = result[name];
    if (list == null) {
      if (arrIndex) {
        var arr = [];
        arr[arrIndex] = value;
        result[name] = arr;
      } else {
        result[name] = value;
      }
    } else {
      if (!Array.isArray(list)) {
        result[name] = list = [list];
      }
      if (arrIndex) {
        list[arrIndex] = value;
      } else {
        list.push(value);
      }
    }
  });
  return result || {};
}

function parseJSON(data) {
  if (typeof data === 'object') {
    return data;
  }
  return parsePureJSON(data, true) || parseLinesJSON(data);
}

function parsePureJSON(data, isValue) {
  if (typeof data != 'string' || !(data = data.trim())) {
    return null;
  }

  try {
    return JSON.parse(data);
  } catch(e) {
    var result = evalJson(data);
    if (result) {
      return result;
    }
  }

  return parseInlineJSON(data, isValue);
}

exports.parseJSON = parseJSON;

function readFileSync(file) {
  try {
    return fs.readFileSync(file, UTF8_OPTIONS);
  } catch(e) {}
}

exports.readFileSync = readFileSync;

function trim(text) {
  return text && text.trim();
}

exports.trim = trim;

function readInjectFiles(data, callback) {
  if (!data) {
    return callback();
  }

  fileMgr.readFilesText([data.prepend, data.replace, data.append], function(result) {
    if (result[0]) {
      data.top = result[0];
    }
    if (result[1]) {
      data.body = result[1];
    }
    if (result[2]) {
      data.bottom = result[2];
    }
    callback(data);
  });
}

exports.readInjectFiles = readInjectFiles;

function lowerCaseify(obj, rawNames) {
  var result = {};
  if (!obj) {
    return result;
  }
  Object.keys(obj).forEach(function(name) {
    var value = obj[name];
    if (value !== undefined) {
      var key  = name.toLowerCase();
      result[key] = Array.isArray(value) ? value : value + '';
      if (rawNames) {
        rawNames[key] = name;
      }
    }
  });
  return result;
}

exports.lowerCaseify = lowerCaseify;

function parseHeaders(headers, rawNames) {
  if (typeof headers == 'string') {
    headers = headers.split(CRLF_RE);
  }
  var _headers = {};
  headers.forEach(function(line) {
    var index = line.indexOf(':');
    var value;
    if (index != -1 && (value = line.substring(index + 1).trim())) {
      var rawName = line.substring(0, index).trim();
      var name = rawName.toLowerCase();
      var list = _headers[name];
      if (rawNames) {
        rawNames[name] = rawName;
      }
      if (list) {
        if (!Array.isArray(list)) {
          _headers[name] = list = [list];
        }
        list.push(value);
      } else {
        _headers[name] = value;
      }
    }
  });

  return lowerCaseify(_headers);
}

exports.parseHeaders = parseHeaders;

var QUERY_PARAM_RE = /^[\w$-]+=/;
function parseRuleJson(rules, callback) {
  if (!Array.isArray(rules)) {
    rules = [rules];
  }

  Q.all(rules.map(function(rule) {
    var defer = Q.defer();
    readRuleList(rule, function(data) {
      defer.resolve(data);
    }, true);
    return defer.promise;
  })).spread(callback);
}

exports.parseRuleJson = parseRuleJson;

function readRuleValue(rule, readFile, callback, checkUrl) {
  if (!rule) {
    return callback();
  }
  if (rule.value) {
    return callback(removeProtocol(rule.value, true));
  }
  var filePath = getMatcherValue(rule);
  if (checkUrl && GEN_URL_RE.test(filePath)) {
    return callback(filePath);
  }
  filePath = decodePath(filePath);
  if (rule.root) {
    filePath = join(rule.root, filePath);
  }
  readFile(filePath, callback);
}

function wrapTag(result, isBin, charset, wrap) {
  var list = [];
  var temp;
  result.forEach(function(data) {
    if (!data) {
      return;
    }
    if (typeof data !== 'string' || !GEN_URL_RE.test(data)) {
      temp = temp || [];
      temp.push(data);
      return;
    }
    temp && list.push(wrap(fileMgr.joinData(temp, !isBin), charset));
    list.push(wrap(data.trim(), charset, true));
    temp = null;
  });
  temp && list.push(wrap(fileMgr.joinData(temp, !isBin), charset));
  return list;
}
var CORS_RE = /^re[qs]Cors:\/\//;
function readRuleList(rule, callback, isJson, charset, isHtml) {
  if (!rule) {
    return callback();
  }
  var len = rule.list && rule.list.length;
  var isBin = protoMgr.isBinProtocol(rule.name);
  var readFile = fileMgr[(isBin && !isJson) ? 'readFile' : 'readFileText'];
  if (!len) {
    return readRuleValue(rule, readFile, isJson ? function(value) {
      callback(parseJSON(value));
    } : callback);
  }
  var result = [];
  var isJsHtml = isHtml && isBin === 2;
  var isCssHtml = isHtml && isBin === 3;
  var execCallback = function() {
    if (--len > 0) {
      return;
    }
    if (isJson) {
      result = result.map(parseJSON).filter(noop);
      if (result.length > 1) {
        result.reverse();
        if (typeof result[0] !== 'object') {
          result[0] = {};
        }
        callback(extend.apply(null, result));
      } else {
        callback(result[0]);
      }
    } else {
      if (isJsHtml) {
        result = wrapTag(result, isBin, charset, wrapJs);
      } else if (isCssHtml) {
        result = wrapTag(result, isBin, charset, wrapCss);
      }
      if (rule.isRawList) {
        callback(result);
      } else {
        callback(fileMgr.joinData(result, !isBin));
      }
    }
  };
  var isCors = CORS_RE.test(rule.matcher);
  var checkUrl = isJsHtml || isCssHtml;
  rule.list.forEach(function (r, i) {
    if (isJson) {
      var value = removeProtocol(getMatcher(r), true);
      if (value) {
        var json = isCors && GEN_URL_RE.test(value) ? { origin: value.trim() }
          : parsePureJSON(value, QUERY_PARAM_RE.test(value));
        if (json) {
          result[i] = json;
          return execCallback();
        }
      }
    }
    readRuleValue(r, readFile, function (value) {
      result[i] = value;
      execCallback();
    }, checkUrl);
  });
}

function getRuleValue(rules, callback, noBody, charset, isHtml) {
  if (noBody || !rules) {
    return callback();
  }
  if (!Array.isArray(rules)) {
    rules = [rules];
  }

  Q.all(rules.map(function(rule) {
    var defer = Q.defer();
    readRuleList(rule, function(data) {
      defer.resolve(data);
    }, false, charset, isHtml);
    return defer.promise;
  })).spread(callback);
}

exports.getRuleValue = getRuleValue;

function decodePath(path) {
  path = getPath(path, true);
  try {
    return decodeURIComponent(path);
  } catch (e) {
    logger.error(e);
  }

  try {
    return qs.unescape(path);
  } catch(e) {
    logger.error(e);
  }

  return path;
}

function getRuleFiles(rule) {
  var files = rule.files || [getPath(getUrl(rule))];
  var root = rule.root;
  var result = [];
  files.map(function(file) {
    file = decodePath(file);
    file = fileMgr.convertSlash(root ? join(root, file) : file);
    if (END_WIDTH_SEP_RE.test(file)) {
      result.push(file.slice(0, -1));
      result.push(join(file, 'index.html'));
    } else {
      result.push(file);
    }
  });
  return result;
}

exports.getRuleFiles = getRuleFiles;

function getRuleFile(rule) {
  var filePath = getPath(getUrl(rule));
  if (!filePath) {
    return filePath;
  }

  return rule.root ? join(rule.root, decodePath(filePath)) : decodePath(filePath);
}

exports.getRuleFile = getRuleFile;

function getValue(rule) {
  return rule.value || rule.path;
}

function getMatcher(rule, raw) {
  rule = rule && (getValue(rule) || rule.matcher);
  if (rule && raw !== true) {
    rule = rule.trim();
  }
  return rule;
}

function getUrl(rule) {
  return rule && (getValue(rule) || rule.url);
}

exports.rule = {
  getMatcher: getMatcher,
  getUrl: getUrl
};

function getMatcherValue(rule, raw) {
  rule = getMatcher(rule, raw);
  return rule && removeProtocol(rule, true);
}

function getUrlValue(rule, raw) {
  rule = getUrl(rule, raw);
  if (rule && raw !== true) {
    rule = rule.trim();
  }
  return rule && removeProtocol(rule, true);
}

exports.getMatcherValue = getMatcherValue;
exports.getUrlValue = getUrlValue;

function _getRawType(type) {
  return typeof type === 'string' ? type.split(';')[0].toLowerCase() : '';
}

function getRawType(data) {
  return _getRawType(data.headers && data.headers['content-type']);
}

exports.getRawType = getRawType;

function getContentType(contentType) {
  if (contentType && typeof contentType != 'string') {
    contentType = contentType['content-type'] || contentType.contentType;
  }
  contentType = _getRawType(contentType);
  if (!contentType) {
    return;
  }
  if (contentType.indexOf('javascript') != -1) {
    return 'JS';
  }

  if (contentType.indexOf('css') != -1) {
    return 'CSS';
  }

  if (contentType.indexOf('html') != -1) {
    return 'HTML';
  }

  if (contentType.indexOf('json') != -1) {
    return 'JSON';
  }

  if (contentType.indexOf('xml') != -1) {
    return 'XML';
  }

  if (contentType.indexOf('text/') != -1) {
    return 'TEXT';
  }

  if (contentType.indexOf('image/') != -1) {
    return 'IMG';
  }
}

exports.getContentType = getContentType;

function supportHtmlTransform(res, req) {
  var headers = res.headers;
  if (getContentType(headers) != 'HTML' || !hasBody(res, req)) {
    return false;
  }

  var contentEncoding = getContentEncoding(headers);
//chrome新增了sdch压缩算法，对此类响应无法解码，deflate无法区分deflate还是deflateRaw
  return !contentEncoding || contentEncoding == 'gzip';
}

exports.supportHtmlTransform = supportHtmlTransform;

function removeUnsupportsHeaders(headers, supportsDeflate) {//只保留支持的zip格式：gzip、deflate
  if (!headers || !headers['accept-encoding']) {
    return;
  }
  var list = headers['accept-encoding'].split(/\s*,\s*/g);
  var acceptEncoding = [];
  for (var i = 0, len = list.length; i < len; i++) {
    var ae = list[i].toLowerCase();
    if (ae && (supportsDeflate && ae == 'deflate' || ae == 'gzip')) {
      acceptEncoding.push(ae);
    }
  }

  if (acceptEncoding = acceptEncoding.join(', ')) {
    headers['accept-encoding'] = acceptEncoding;
  } else {
    delete headers['accept-encoding'];
  }
}

exports.removeUnsupportsHeaders = removeUnsupportsHeaders;

var HEAD_RE = /^head$/i;
function hasBody(res, req) {
  if (req && HEAD_RE.test(req.method)) {
    return false;
  }
  var statusCode = res.statusCode;
  return !(statusCode == 204 || (statusCode >= 300 && statusCode < 400) ||
    (100 <= statusCode && statusCode <= 199));
}

exports.hasBody = hasBody;

function hasRequestBody(req) {
  req = typeof req == 'string' ? req : req.method;
  if (typeof req != 'string') {
    return false;
  }

  req = req.toUpperCase();
  return !(req === 'GET' || req === 'HEAD' ||
  req === 'OPTIONS' || req === 'CONNECT');
}

exports.hasRequestBody = hasRequestBody;

function getContentEncoding(headers) {
  var encoding = toLowerCase(headers && headers['content-encoding'] || headers);
  return encoding === 'gzip' || encoding === 'deflate' ? encoding : null;
}

exports.getContentEncoding = getContentEncoding;

function getZipStream(headers) {
  switch (getContentEncoding(headers)) {
  case 'gzip':
    return zlib.createGzip();
  case 'deflate':
    return zlib.createDeflate();
  }
}

function getUnzipStream(headers) {
  switch (getContentEncoding(headers)) {
  case 'gzip':
    return zlib.createGunzip();
  case 'deflate':
    return zlib.createInflate();
  }
}

exports.getZipStream = getZipStream;
exports.getUnzipStream = getUnzipStream;
exports.isWhistleTransformData = function(obj) {
  if (!obj) {
    return false;
  }
  if (obj.speed > 0 || obj.delay > 0) {
    return true;
  }
  return !!(obj.top || obj.body || obj.bottom);
};

function getPipeIconvStream(headers) {
  var pipeStream = new PipeStream();
  var charset = getCharset(headers['content-type']);

  if (charset) {
    pipeStream.addHead(iconv.decodeStream(charset));
    pipeStream.addTail(iconv.encodeStream(charset));
  } else {
    pipeStream.addHead(function(res, next) {
      var buffer, iconvDecoder;

      res.on('data', function(chunk) {
        buffer = buffer ? Buffer.concat([buffer, chunk]) : chunk;
        resolveCharset(buffer);
      });
      res.on('end', resolveCharset);

      function resolveCharset(chunk) {
        if (!charset) {
          if (chunk && buffer.length < 25600) {
            return;
          }
          charset = (!buffer || isUtf8(buffer)) ? 'utf8' : 'GB18030';
        }
        if (!iconvDecoder) {
          iconvDecoder = iconv.decodeStream(charset);
          next(iconvDecoder);
        }
        if (buffer) {
          iconvDecoder.write(buffer);
          buffer = null;
        }
        !chunk && iconvDecoder.end();
      }

    });

    pipeStream.addTail(function(src, next) {
      next(src.pipe(iconv.encodeStream(charset)));
    });
  }

  return pipeStream;
}

exports.getPipeIconvStream = getPipeIconvStream;

function toLowerCase(str) {
  return typeof str == 'string' ?  str.trim().toLowerCase() : str;
}

exports.toLowerCase = toLowerCase;

function toUpperCase(str) {
  return typeof str == 'string' ?  str.trim().toUpperCase() : str;
}

exports.toUpperCase = toUpperCase;

var CHARSET_RE = /charset=([\w-]+)/i;

function getCharset(str) {
  var charset;
  if (CHARSET_RE.test(str)) {
    charset = RegExp.$1;
    if (!iconv.encodingExists(charset)) {
      return;
    }
  }

  return charset;
}

exports.getCharset = getCharset;

function getForwardedFor(headers) {
  var val = headers[config.CLIENT_IP_HEAD];
  if (!val || typeof val !== 'string') {
    return '';
  }
  var index = val.indexOf(',');
  if (index !== -1) {
    val = val.substring(0, index);
  }
  val = removeIPV6Prefix(val.trim());
  return net.isIP(val) && !isLocalAddress(val) ? val : '';
}
exports.getForwardedFor = getForwardedFor;

function isLocalIp(ip) {
  if (!ip || typeof ip !== 'string') {
    return true;
  }
  return ip.length < 7 || ip === LOCALHOST;
}

function getClientIp(req) {
  var ip;
  var headers = req.headers || {};
  try {
    ip = getForwardedFor(headers);
    if (!ip) {
      ip = (req.connection || req.socket || req).remoteAddress;
      ip = removeIPV6Prefix(ip);
    }
  } catch(e) {}
  return isLocalIp(ip) ? LOCALHOST : ip;
}

exports.getClientIp = getClientIp;

exports.getClientPort = function(req) {
  var headers = req.headers || {};
  var port = headers[config.CLIENT_PORT_HEAD];
  if (port > 0) {
    return port;
  }
  try {
    port = (req.connection || req.socket || req).remotePort;
  } catch(e) {}
  return port > 0 ? port : 0;
};

function removeIPV6Prefix(ip) {
  if (typeof ip != 'string') {
    return '';
  }

  return ip.indexOf('::ffff:') === 0 ? ip.substring(7) : ip;
}

exports.removeIPV6Prefix = removeIPV6Prefix;

function isUrlEncoded(req) {

  return /^post$/i.test(req.method) && /urlencoded/i.test(req.headers && req.headers['content-type']);
}

exports.isUrlEncoded = isUrlEncoded;
function isJSONContent(req) {
  if (!hasRequestBody(req)) {
    return false;
  }
  return getContentType(req.headers) === 'JSON';
}

exports.isJSONContent = isJSONContent;

exports.isProxyPort = function(proxyPort) {
  return proxyPort == config.port || proxyPort == config.httpsPort
    || proxyPort == config.httpPort || proxyPort == config.socksPort
    || (config.realPort && proxyPort == config.realPort);
};

function isMultipart(req) {
  return /multipart/i.test(req.headers['content-type']);
}

exports.isMultipart = isMultipart;

function getQueryString(url) {
  var index = url.indexOf('?');
  return index == -1 ? '' : url.substring(index + 1);
}

exports.getQueryString = getQueryString;

function replaceQueryString(query, replaceQuery) {
  if (replaceQuery && typeof replaceQuery != 'string') {
    replaceQuery = qs.stringify(replaceQuery);
  }
  if (!query || !replaceQuery) {
    return query || replaceQuery;
  }

  var queryList = [];
  var params = {};
  var filterName = function(param) {
    var index = param.indexOf('=');
    var name, value;
    if (index == -1) {
      name = param;
      value = null;
    } else {
      name = param.substring(0, index);
      value = param.substring(index + 1);
    }

    var exists = name in params;
    params[name] = value;
    return exists ? null : name;
  };

  query = query.split('&').map(filterName);
  replaceQuery = replaceQuery.split('&').map(filterName);
  query.concat(replaceQuery).forEach(function(name) {
    var value = name ? params[name] : null;
    if (value != null) {
      queryList.push(name + '=' + value);
    }
  });

  return queryList.join('&');
}

exports.replaceQueryString = replaceQueryString;

function replaceUrlQueryString(url, queryString) {
  if (!queryString) {
    return url;
  }
  url = url || '';
  var hashIndex = url.indexOf('#');
  var hashString = '';
  if (hashIndex != -1) {
    hashString = url.substring(hashIndex);
    url = url.substring(0, hashIndex);
  }
  queryString = replaceQueryString(getQueryString(url), queryString);

  return url.replace(/\?.*$/, '') + (queryString ? '?' +  queryString : '') + hashString;
}

exports.replaceUrlQueryString = replaceUrlQueryString;
exports.decodeBuffer = fileMgr.decode;

function setHeaders(data, obj) {
  data.headers = data.headers || {};
  for (var i in obj) {
    data.headers[i] = obj[i];
  }
  return data;
}

exports.setHeaders = setHeaders;

function setHeader(data, name, value) {
  data.headers = data.headers || {};
  data.headers[name] = value;
  return data;
}

exports.setHeader = setHeader;

function join(root, dir) {
  return root ? path.resolve(root, dir) : dir;
}

exports.join = join;

function resolveProperties(list) {
  var result = {};
  if (list) {
    list.map(getMatcherValue).join('|').split('|').forEach(function(action) {
      if (action) {
        result[action] = true;
      }
    });
  }
  return result;
}

exports.resolveProperties = resolveProperties;

function resolveIgnore(ignore) {
  var keys = Object.keys(ignore);
  var exclude = {};
  var ignoreAll;
  ignore = {};
  keys.forEach(function(name) {
    if (name.indexOf('ignore.') === 0 || name.indexOf('ignore:') === 0) {
      exclude[name.substring(7)] = 1;
      return;
    }
    if (name.indexOf('-') === 0 || name.indexOf('!') === 0) {
      exclude[name.substring(1)] = 1;
      return;
    }
    name = name.replace('ignore|', '');
    if (name === 'filter' || name === 'ignore') {
      return;
    }
    if (name === 'allRules' || name === 'allProtocols'
      || name === 'All' || name === '*') {
      ignoreAll = true;
      return;
    }
    ignore[aliasProtocols[name] || name] = 1;
  });
  if (ignoreAll) {
    protocols.forEach(function(name) {
      ignore[name] = 1;
    });
    keys = protocols;
  } else {
    keys = Object.keys(ignore);
  }
  keys.forEach(function(name) {
    if (exclude[name]) {
      delete ignore[name];
    }
  });
  return {
    ignoreAll: ignoreAll,
    exclude: exclude,
    ignore: ignore
  };
}

function resolveFilter(ignore, filter) {
  filter = filter || {};
  var result = resolveIgnore(ignore);
  ignore = result.ignore;
  Object.keys(ignore).forEach(function(name) {
    if (protocols.indexOf(name) === -1) {
      filter['ignore|' + name] = true;
    } else {
      filter[name] = true;
    }
  });
  Object.keys(result.exclude).forEach(function(name) {
    filter['ignore:' + name] = 1;
  });
  if (result.ignoreAll) {
    filter.allRules = 1;
  }
  return filter;
}

exports.resolveFilter = resolveFilter;

exports.isIgnored = function(filter, name) {
  return !filter['ignore:' + name] && (filter[name] || filter['ignore|' + name]);
};

function resolveRuleProps(rule, result) {
  result = result || {};
  if (rule) {
    rule.list.forEach(function(rule) {
      getMatcherValue(rule)
        .split('|')
          .forEach(function(action) {
            result[action] = true;
          });
    });
  }
  return result;
}

var PLUGIN_RE = /^(?:plugin|whistle)\.[a-z\d_\-]+$/;
var enableRules = ['https', 'intercept', 'capture', 'hide'];

function ignorePlugins(rules, name, exclude) {
  var isPlugin = name === 'plugin';
  if (!isPlugin && !PLUGIN_RE.test(name)) {
    return;
  }
  if (rules.plugin) {
    var list = rules.plugin.list;
    for (var i = list.length - 1; i >= 0; i--) {
      var pName = getProtocolName(list[i].matcher);
      if ((isPlugin || name === pName) && !exclude[pName]) {
        list.splice(i, 1);
      }
    }
    if (!list.length) {
      delete rules.plugin;
    }
  }
  return true;
}

function getProtocolName(url) {
  return url.substring(0, url.indexOf(':'));
}

function ignoreForwardRule(rules, name, exclude) {
  var isRule = name === 'rule';
  if (!isRule && rules[name]) {
    return;
  }
  if (rules.rule) {
    var pName = getProtocolName(rules.rule.url);
    if ((isRule || name === pName) && !exclude[pName]) {
      delete rules.rule;
    }
  }
  return true;
}

function ignoreProxy(rules, name, exclude) {
  if (!rules.proxy) {
    return;
  }
  if (name === 'proxy') {
    delete rules.proxy;
    return true;
  }
  if (!PROXY_RE.test(name)) {
    return;
  }
  var pName = getProtocolName(rules.proxy.url);
  var realName = aliasProtocols[name] || name;
  var realPName = aliasProtocols[pName] || pName;
  if (realName === realPName && !exclude[pName] && !exclude[realPName]) {
    delete rules.proxy;
  }
  return true;
}

function ignoreRules(rules, ignore, isResRules) {
  var result = resolveIgnore(ignore);
  var ignoreAll = result.ignoreAll;
  var exclude = result.exclude;
  ignore = result.ignore;
  var keys = Object.keys(ignoreAll ? rules : ignore);
  keys.forEach(function(name) {
    if (name === 'filter' || name === 'ignore' || exclude[name]) {
      return;
    }
    if (!isResRules || protoMgr.resProtocols.indexOf(name) !== -1) {
      if (ignorePlugins(rules, name, exclude)
        || ignoreProxy(rules, name, exclude)
        || ignoreForwardRule(rules, name, exclude)) {
        return;
      }
      delete rules[name];
    }
  });
}

exports.ignoreRules = ignoreRules;

function filterRepeatPlugin(rule) {
  if (rule.name !== 'plugin') {
    return;
  }
  var exists = {};
  rule.list = rule.list.filter(function(p) {
    var protocol = p.matcher.substring(p.matcher.indexOf('.'), p.matcher.indexOf(':'));
    if (!exists[protocol]) {
      exists[protocol] = 1;
      return true;
    }
    return false;
  });
}

exports.filterRepeatPlugin = filterRepeatPlugin;

function mergeRule(curRule, newRule) {
  if (!curRule || !newRule) {
    return newRule;
  }
  if (!newRule.list) {
    return newRule;
  }
  curRule.list = curRule.list.concat(newRule.list);
  filterRepeatPlugin(curRule);
  return curRule;
}

function mergeRules(req, add, isResRules) {
  var origin = req.rules;
  var origAdd = add;
  add = add || {};
  var merge = function(protocol) {
    var rule = mergeRule(origin[protocol], add[protocol]);
    if (rule) {
      origin[protocol] = rule;
    }
  };
  if (isResRules && origAdd) {
    protoMgr.resProtocols.forEach(merge);
  } else if (origAdd) {
    Object.keys(origAdd).forEach(merge);
  }

  req['delete'] = resolveRuleProps(origin['delete'], req['delete']);
  req.filter = resolveRuleProps(origin.filter, req.filter);
  req.disable = resolveRuleProps(origin.disable, req.disable);
  req.ignore = resolveRuleProps(origin.ignore, req.ignore);
  req.enable = resolveRuleProps(origin.enable, req.enable);
  enableRules.forEach(function(rule) {
    if (req.enable[rule]) {
      req.filter[rule] = true;
    }
  });
  ignoreRules(origin, extend(req.ignore, req.filter), isResRules);
  return add;
}

exports.mergeRules = mergeRules;

function resolveHeaderReplacement(rule, isRes) {
  var list = rule && rule.list;
  if (!list) {
    return;
  }
  var opList;
  var prefixLen = 20;
  var prefix = 'headerReplace://re' + (isRes ? 's' : 'q') + '.';
  rule.list.forEach(function(rule) {
    var matcher = rule.matcher;
    if (matcher.indexOf(prefix)) {
      return;
    }
    var index = matcher.indexOf(':', prefixLen);
    if (index === -1) {
      return;
    }
    var name = matcher.substring(prefixLen, index).trim();
    var value = name && matcher.substring(index + 1).trim();
    value = value && parseQuery(value);
    if (!value) {
      return;
    }
    opList = opList || [];
    Object.keys(value).forEach(function(key) {
      var pattern = toOriginalRegExp(key);
      opList.push({
        regExp: pattern,
        name: name.toLowerCase(),
        key: key,
        value: value[key] || ''
      });
    });
  });
  return opList;
}

function replaceHeader(str, regExp, key, value) {
  if (str == null || str === '') {
    return str;
  }
  str = String(str);
  if (!regExp || !SUB_MATCH_RE.test(value)) {
    return str.replace(regExp || key, value);
  }
  return str.replace(regExp, function() {
    return replacePattern(value, arguments);
  });
}

function handleHeaderReplace(headers, rule, isRes) {
  var opList = resolveHeaderReplacement(rule, isRes);
  if (opList) {
    opList.forEach(function(item) {
      var header = headers[item.name];
      if (header == null || header === '') {
        return;
      }
      var regExp = item.regExp;
      var key = item.key;
      var value = item.value;
      if (Array.isArray(header)) {
        headers[item.name] = header.map(function(str) {
          return replaceHeader(str, regExp, key, value);
        });
      } else {
        headers[item.name] = replaceHeader(header, regExp, key, value);
      }
    });
  }
}

exports.handleReqHeaderReplace = handleHeaderReplace;

exports.handleResHeaderReplace = function(headers, rule) {
  handleHeaderReplace(headers, rule, true);
};

function transformReq(req, res, port, host) {
  var options = parseUrl(getFullUrl(req));
  options.host = host || LOCALHOST;
  options.method = req.method;
  options.hostname = null;
  options.protocol = null;
  options.agent = false;
  if (port > 0) {
    options.port = port;
  }
  if(req.clientIp || !req.headers[config.CLIENT_IP_HEAD]) {
    req.headers[config.CLIENT_IP_HEAD] = req.clientIp || getClientIp(req);
  }
  options.headers = req.headers;
  var client = http.request(options, function(_res) {
    if (getStatusCode(_res.statusCode)) {
      res.writeHead(_res.statusCode, _res.headers);
      _res.pipe(res);
      _res.trailers && res.addTrailers(_res.trailers);
    } else {
      sendStatusCodeError(res, _res);
    }
  });
  client.on('error', function(err) {
    res.emit('error', err);
  });
  req.pipe(client);
  return client;
}
exports.transformReq = transformReq;

function trimStr(str) {
  if (typeof str !== 'string') {
    return '';
  }
  return str.trim();
}

exports.trimStr = trimStr;

function hasHeaderRules(headers) {
  return headers['x-whistle-rule-key'] ||
           headers['x-whistle-rule-value'] ||
           headers['x-whistle-rule-host'];
}

function checkIfAddInterceptPolicy(proxyHeaders, headers) {
  if (hasHeaderRules(headers)) {
    proxyHeaders['x-whistle-policy'] = 'intercept';
    return true;
  }
}

exports.checkIfAddInterceptPolicy = checkIfAddInterceptPolicy;

function getCgiUrl(url) {
  if (!url || typeof url !== 'string' || !(url = url.trim())) {
    return;
  }
  return url[0] === '/' ? url.substring(1) : url;
}
exports.getCgiUrl = getCgiUrl;

function getString(str) {
  if (!str || typeof str !== 'string') {
    return;
  }
  return str.trim();
}

function getPage(page) {
  page = getCgiUrl(page);
  return !page || page.length > 128 || !/\.html?$/i.test(page) ? null : page;
}

exports.getPluginMenu = function(menus, pluginName) {
  if (!Array.isArray(menus)) {
    return;
  }
  var len = menus.length;
  var count = 3;
  var map = {};
  var result, menu, name, page;
  for (var i = 0; i < len; i++) {
    if ((menu = menus[i]) && (name = getString(menu.name)) && !map[name]
      && (page = getPage(menu.page || menu.action)) && page.indexOf('#') === -1) {
      result = result || [];
      map[name] = 1;
      result.push({
        name: name.substring(0, 20),
        action: 'plugin.' + pluginName + '/' + page,
        required: menu.required ? true : undefined
      });
      if (--count === 0) {
        return result;
      }
    }
  }
  return result;
};

var MAX_HINT_LEN = 512;

exports.getHintList = function(conf) {
  var hintList = conf.hintList;
  if (!Array.isArray(hintList) || !hintList.length) {
    return;
  }
  var result;
  hintList.forEach(function(hint) {
    if (typeof hint === 'string') {
      if (hint.length <= MAX_HINT_LEN) {
        result = result || [];
        result.push(hint);
      }
    } else if (hint && typeof hint.value === 'string') {
      var help = hint.help;
      if (typeof help !== 'string') {
        help = '';
      }
      if (hint.value.length + help.length <= MAX_HINT_LEN) {
        result = result || [];
        result.push({
          text: hint.value.trim(),
          help: help.trim()
        });
      }
    }
  });
  return result;
};

function toString(str) {
  if (str != null) {
    if (typeof str === 'string') {
      return str;
    }
    try {
      return JSON.stringify(str);
    } catch (e) {}
  }
  return '';
}
exports.toString = toString;

var index = 0;

function padReqId(num) {
  if (num > 99) {
    return num;
  }
  if (num > 9) {
    return '0' + num;
  }
  return '00' + num;
}

exports.getReqId = function() {
  if (index > 999) {
    index = 0;
  }
  return Date.now() +'-' + padReqId(index++);
};

exports.onSocketEnd = function(socket, callback) {
  var execCallback = function(err) {
    if (callback) {
      callback(err);
      callback = null;
    }
  };
  if (socket.aborted || socket.finished || socket.destroyed) {
    return execCallback();
  }
  socket.on('error', execCallback);
  socket.once('finish', execCallback);
  socket.once('close', execCallback);
};

exports.getEmptyRes = function getRes() {
  var res = new PassThrough();
  res._transform = noop;
  res.on('data', noop);
  res.destroy = noop;
  return res;
};

var REQ_HEADER_RE = /^req\.headers\.(.+)$/;
var RES_HEADER_RE = /^res\.headers\.(.+)$/;
var HEADER_RE = /^headers\.(.+)$/;

function parseDeleteProperties(req) {
  var deleteRule = req['delete'];
  var reqHeaders = {};
  var resHeaders = {};
  if (deleteRule) {
    Object.keys(deleteRule).forEach(function(prop) {
      if (REQ_HEADER_RE.test(prop)) {
        reqHeaders[RegExp.$1.toLowerCase()] = 1;
      } else if (RES_HEADER_RE.test(prop)) {
        resHeaders[RegExp.$1.toLowerCase()] = 1;
      } else if (HEADER_RE.test(prop)) {
        reqHeaders[RegExp.$1.toLowerCase()] = 1;
        resHeaders[RegExp.$1.toLowerCase()] = 1;
      }
    });
  }
  return {
    reqHeaders: reqHeaders,
    resHeaders: resHeaders
  };
}

exports.parseDeleteProperties = parseDeleteProperties;

var URL_RE = /^https?:\/\/./;
function parseOrigin(origin) {
  if (!origin || typeof origin !== 'string') {
    return;
  }
  var index = origin.indexOf('//');
  if (index !== -1) {
    index = origin.indexOf('/', index + 2);
    if (index != -1) {
      origin = origin.substring(0, index);
    }
  }
  return origin;
}

exports.setReqCors = function(data, cors) {
  if (!cors) {
    return;
  }
  cors = lowerCaseify(cors);
  var origin;
  if (cors.origin === '*') {
    origin = cors.origin;
  } else if (URL_RE.test(cors.origin)) {
    origin = parseOrigin(cors.origin);
  }
  if (origin !== undefined) {
    setHeader(data, 'origin', origin);
  } else if (cors['*'] === '') {
    setHeader(data, 'origin', '*');
  }
  if (cors.method !== undefined) {
    setHeader(data, 'access-control-request-method', cors.method);
  }
  if (cors.headers !== undefined) {
    setHeader(data, 'access-control-request-headers', cors.headers);
  } 
};

function isEnableCors(cors) {
  return cors.enable === '' || cors['use-credentials'] === '' || cors['credentials'] === '';
}

exports.setResCors = function(data, cors, origin, isOptions) {
  if (!cors) {
    return;
  }
  cors = lowerCaseify(cors);
  var cusOrigin;
  if (cors.origin === '*') {
    cusOrigin = cors.origin;
  } else if (URL_RE.test(cors.origin)) {
    cusOrigin = parseOrigin(cors.origin);
  }
  if (cusOrigin || isEnableCors(cors)) {
    origin = cusOrigin || origin;
    setHeaders(data, {
      'access-control-allow-credentials': !!origin,
      'access-control-allow-origin': origin || '*'
    });
  } else if (cors['*'] === '') {
    setHeader(data, 'access-control-allow-origin', '*');
  }
  
  if (cors.methods !== undefined) {
    setHeader(data, 'access-control-allow-methods', cors.methods);
  }

  if (cors.headers !== undefined) {
    var operate = (isOptions ? 'allow' : 'expose');
    setHeader(data, 'access-control-' + operate + '-headers', cors.headers);
  }

  if (cors.credentials !== undefined) {
    setHeader(data, 'access-control-allow-credentials', cors.credentials);
  }

  if (cors.maxage !== undefined) {
    setHeader(data, 'access-control-max-age', cors.maxage);
  }
};

exports.disableReqProps = function(req) {
  var disable = req.disable;
  var headers = req.headers;

  if (disable.ua) {
    delete headers['user-agent'];
  }

  if (disable.gzip) {
    delete headers['accept-encoding'];
  }

  if (disable.cookie || disable.cookies || disable.reqCookie || disable.reqCookies) {
    delete headers.cookie;
  }

  if (disable.referer || disable.referrer) {
    delete headers.referer;
  }

  if (disable.ajax) {
    delete headers['x-requested-with'];
  }

  if (disable.cache) {
    disableReqCache(headers);
  }
};

exports.disableResProps = function(req, headers) {
  var disable = req.disable;
  if (disable.cookie || disable.cookies || disable.resCookie || disable.resCookies) {
    delete headers['set-cookie'];
  }
  if (disable.cache) {
    headers['cache-control'] = 'no-cache';
    headers.expires = new Date(Date.now() -60000000).toGMTString();
    headers.pragma = 'no-cache';
  }
  disable.csp && disableCSP(headers);
};

var G_INVALID_NAME_CHAR_RE = /[^\x00-\xFF]|[\r\n;=%]/g;
var INVALID_NAME_CHAR_RE = /[\r\n;=]/;
function escapeName(name) {
  if (!name || (!NON_LATIN1_RE.test(name) && !INVALID_NAME_CHAR_RE.test(name))) {
    return name;
  }
  return name.replace(G_INVALID_NAME_CHAR_RE, safeEncodeURIComponent);
}

var G_INVALID_VALUE_CHAR_RE = /[^\x00-\xFF]|[\r\n;%]/g;
var INVALID_VALUE_CHAR_RE = /[\r\n;]/;
function escapeValue(value) {
  if (!value || typeof value !== 'string') {
    return value = value == null ? '' : String(value);
  }
  if (!NON_LATIN1_RE.test(value) && !INVALID_VALUE_CHAR_RE.test(value)) {
    return value;
  }
  return value.replace(G_INVALID_VALUE_CHAR_RE, safeEncodeURIComponent);
}

exports.setReqCookies = function(data, cookies, curCookies) {
  var list = cookies && Object.keys(cookies);
  if (!list || !list.length) {
    return;
  }
  var result = {};
  if (curCookies && typeof curCookies == 'string') {
    curCookies.split(/;\s*/g).forEach(function(cookie) {
      var index = cookie.indexOf('=');
      if (index == -1) {
        result[cookie] = null;
      } else {
        result[cookie.substring(0, index)] = cookie.substring(index + 1);
      }
    });
  }

  list.forEach(function(name) {
    var value = cookies[name];
    value = value && typeof value == 'object' ? value.value : value;
    result[escapeName(name)] = value ? escapeValue(value) : value;
  });

  cookies = Object.keys(result).map(function(name) {
    var value = result[name];
    return name + (value == null ? '' : '=' + value);
  }).join('; ');
  setHeader(data, 'cookie', cookies);
};

exports.setResCookies = function(data, cookies) {
  var list = cookies && Object.keys(cookies);
  if (!list || !list.length) {
    return;
  }
  var curCookies = data.headers && data.headers['set-cookie'];
  if (!Array.isArray(curCookies)) {
    curCookies = curCookies ? [curCookies + ''] : [];
  }

  var result = {};
  curCookies.forEach(function(cookie) {
    var index = cookie.indexOf('=');
    if (index == -1) {
      result[cookie] = null;
    } else {
      result[cookie.substring(0, index)] = cookie.substring(index + 1);
    }
  });

  list.forEach(function(name) {
    var cookie = cookies[name];
    name = escapeName(name);
    if (!cookie || typeof cookie != 'object') {
      result[name] = cookie ? escapeValue(cookie) : cookie;
    } else {
      var attrs = [];
      var value = cookie.value;
      attrs.push(escapeValue(value));
      var maxAge = cookie.maxAge || cookie.maxage || cookie['Max-Age'] || cookie['max-age'];
      maxAge = parseInt(cookie.maxAge, 10);
      if (!Number.isNaN(maxAge)) {
        attrs.push('Expires=' + new Date(Date.now() + maxAge * 1000).toGMTString());
        attrs.push('Max-Age=' + maxAge);
      }

      cookie.secure && attrs.push('Secure');
      cookie.path && attrs.push('Path=' + cookie.path);
      cookie.domain && attrs.push('Domain=' + cookie.domain);
      (cookie.httpOnly || cookie.httponly) && attrs.push('HttpOnly');
      var sameSite = cookie.sameSite || cookie.samesite || cookie.SameSite;
      sameSite && attrs.push('SameSite=' + sameSite);
      result[name] = attrs.join('; ');
    }
  });

  cookies = Object.keys(result).map(function(name) {
    var value = result[name];
    return name + (value == null ? '' : '=' + value);
  });
  setHeader(data, 'set-cookie', cookies);
};

exports.escapeRegExp = function (str) {
  if (!str) {
    return '';
  }
  return str.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
};

exports.checkTlsError = function(err) {
  if (!err) {
    return false;
  }
  if (err.code === 'EPROTO') {
    return true;
  }
  var stack = err.stack || err.message;
  if (!stack || typeof stack !== 'string') {
    return false;
  }
  if (stack.indexOf('TLSSocket.onHangUp') !== -1) {
    return true;
  }
  return stack.toLowerCase().indexOf('openssl') !== -1;
};
exports.checkAuto2Http = function(req, ip, proxyUrl) {
  return !req.disable.auto2http && (req.enable.auto2http
    || req.rules.host || (!proxyUrl && isLocalAddress(ip)));
};

exports.setProxyHost = function(req, options, reserve) {
  var phost = req._phost || options;
  var opts = reserve ? options : extend({}, options);
  opts.host = phost.hostname;
  if (phost.port > 0) {
    opts.port = phost.port;
  }
  opts.headers = opts.headers || {};
  config.setHeader(opts.headers, 'host', opts.host + ':' + opts.port);
  return opts;
};

var IPV6_RE = /^[:\da-f]*:[\da-f]*:[\da-f]+$/i;
exports.getHostIp = function(ip, port) {
  if (!port) {
    return ip;
  }
  if (IPV6_RE.test(ip)) {
    ip = '[' + ip + ']';
  }
  return ip + ':' + port;
};

function getMethod(method) {
  if (typeof method !== 'string') {
    return 'GET';
  }
  return method.trim().toUpperCase() || 'GET';
}

exports.getMethod = getMethod;

var COMMENT_RE = /^\s*#/;
var SCRIPT_RE = /\b(?:rules|values)\b/;
function isRulesContent(ctn) {
  return COMMENT_RE.test(ctn) || !SCRIPT_RE.test(ctn);
}
exports.isRulesContent = isRulesContent;

var RESPONSE_FOR_NAME = /^name=(.+)$/;
exports.setResponseFor = function(rules, headers, req, serverIp) {
  var responseFor = getMatcherValue(rules.responseFor);
  if (!responseFor) {
    if (req.isPluginReq && !isLocalAddress(serverIp)) {
      responseFor = trimStr(headers['x-whistle-response-for']);
      responseFor = responseFor ? responseFor.split(',').map(trim).filter(noop) : [];
      if (responseFor.indexOf(serverIp) === -1) {
        responseFor.push(serverIp);
      }
      headers['x-whistle-response-for'] = responseFor.join(', ');
    }
    return;
  }
  var reqHeaders = req.headers;
  if (RESPONSE_FOR_NAME.test(responseFor)) {
    var result = RegExp.$1.toLowerCase().split(',');
    var reqResult = [];
    result = result.map(function(name) {
      if (name.indexOf('req.') === 0) {
        name = reqHeaders[name.substring(4)];
        name && reqResult.push(name);
        return;
      }
      return headers[name];
    }).filter(noop);
    result.push(serverIp || '127.0.0.1');
    responseFor = result.concat(reqResult).join(', ');
  }
  headers['x-whistle-response-for'] = responseFor;
};

exports.getNoPluginServerMsg = function(rule) {
  var msg = 'No implement plugin.server';
  if (rule) {
    msg += '\n       try to set the following rules:\n       <strong>'
      + rule.pattern +' whistle.' + rule.matcher + '</strong>';
  }
  return msg;
};
var CONFIG_VAR_RE = /\${(port|version)}/ig;
function setConfigVarFn(_, name) {
  return config[name.toLowerCase()];
}
var PLUGIN_RULES_URL_RE = /^whistle\.[a-z\d_\-]+/i;
exports.getPluginRulesUrl = function(rulesUrl) {
  if (!PLUGIN_RULES_URL_RE.test(rulesUrl)) {
    return rulesUrl;
  }
  var pluginName = RegExp['$&'].toLowerCase();
  rulesUrl = rulesUrl.substring(pluginName.length) || '/';
  return 'http://127.0.0.1:' + config.port + '/' + pluginName + rulesUrl; 
};
exports.setConfigVar = function(str) {
  return str.replace(CONFIG_VAR_RE, setConfigVarFn);
};

function isCustomParser(req) {
  var enable = req.enable || '';
  return enable.customParser || enable.customParser || enable.customFrame;
}
exports.isCustomParser = isCustomParser;

exports.getParserStatus = function(req) {
  if (!isCustomParser(req)) {
    return;
  }
  var enable = req.enable;
  var customParser = ['custom'];
  if (enable.pauseSend) {
    customParser.push('pauseSend');
  } else if (enable.ignoreSend) {
    customParser.push('ignoreSend');
  }
  if (enable.pauseReceive) {
    customParser.push('pauseReceive');
  } else if (enable.ignoreReceive) {
    customParser.push('ignoreReceive');
  }
  return customParser.join();
};

exports.isInspect = function(enable) {
  return enable.inspect || enable.pauseReceive ||
    enable.pauseSend || enable.ignoreReceive || enable.ignoreSend;
};

var BYTES_RANGE_RE = /^\s*bytes=/i;

exports.parseRange = function(req, size) {
  var range = size && req.headers.range;
  if (!range || !BYTES_RANGE_RE.test(range)) {
    return;
  }
  range = range.substring(range.indexOf('=') + 1).trim();
  if (!range) {
    return;
  }
  var start = size;
  var end = -1;
  range = range.split(',').forEach(function(item) {
    item = item.split('-');
    var s = parseInt(item[0], 10);
    var e = parseInt(item[1], 10);
    if (isNaN(s)) {
      if (isNaN(e)) {
        return;
      }
      s = size - e;
    } else if (isNaN(e)) {
      e = size - 1;
    }
    start = Math.min(s, start);
    end = Math.max(end, e); 
  });
  if (start < 0 || end < 0 || start > end || end >= size) {
    return;
  }
  return {
    start: start,
    end: end
  };
};

exports.parseClientInfo = function(req) {
  var clientInfo = req.headers[config.CLIENT_INFO_HEAD] || '';
  if (clientInfo) {
    delete req.headers[config.CLIENT_INFO_HEAD];
    clientInfo = String(clientInfo).split(',');
    if (!net.isIP(clientInfo[0]) || !(clientInfo[1] > 0)) {
      return '';
    }
  }
  return clientInfo;
};

exports.connect = function(options, callback) {
  var socket, timer, done, retry;
  var execCallback = function(err) {
    clearTimeout(timer);
    timer = null;
    if (!done) {
      done = true;
      err ? callback(err) : callback(null, socket);
    }
  };
  var handleConnect = function() {
    execCallback();
  };
  var handleError = function(err) {
    if (done) {
      return;
    }
    socket.removeAllListeners();
    socket.on('error', noop);
    socket.destroy(err);
    clearTimeout(timer);
    if (retry) {
      return execCallback(err);
    }
    retry = true;
    timer = setTimeout(handleTimeout, 12000);
    try {
      socket = sockMgr.connect(options, handleConnect);
    } catch (e) {
      return execCallback(e);
    }
    socket.on('error', handleError);
    socket.on('close', function(err) {
      !done && execCallback(err || new Error('closed'));
    });
  };
  var handleTimeout = function() {
    handleError(new Error('Timeout'));
  };
  var sockMgr = options.ALPNProtocols ? tls : net;
  timer = setTimeout(handleTimeout, 6000);
  try {
    socket = sockMgr.connect(options, handleConnect);
  } catch (e) {
    return execCallback(e);
  }
  socket.on('error', handleError);
};

exports.checkPluginReqOnce = function(req) {
  var isPluginReq = req.headers[config.PROXY_ID_HEADER] == 1;
  if (isPluginReq) {
    delete req.headers[config.PROXY_ID_HEADER];
  }
  return isPluginReq; 
};

exports.checkPort = function(port, host, cb) {
  if (typeof host !== 'string') {
    cb = host;
    host = '127.0.0.1';
  }
  if (!port) {
    return cb();
  }
  var server = http.createServer();
  server.listen(port, host, function() {
    server.close(cb);
  });
};

var boundIpDefer;
exports.getBoundIp = function(cb) {
  if (boundIpDefer) {
    return boundIpDefer.done(cb);
  }
  var defer = Q.defer();
  boundIpDefer = defer.promise;
  boundIpDefer.done(cb);
  if (!config.host || net.isIP(config.host)) {
    return defer.resolve(config.host);
  }
  dns.lookup(config.host, function(err, ip) {
    if (err) {
      throw err;
    }
    defer.resolve(ip);
  });
};

exports.getPluginMenuConfig = function (conf) {
  var menuConfig = conf.menuConfig;
  var result;
  if (menuConfig != null) {
    try {
      result = JSON.stringify(menuConfig);
    } catch (e) {}
  }
  return '<script>window.whistleMenuConfig = ' + (result || '{}') + ';</script>';
};

exports.isEnableH2 = function(req) {
  var enable = req.enable || '';
  var disable = req.disable || '';
  return enable.h2 && !disable.h2;
};

exports.isDisableH2 = function(req, strict) {
  var enable = req.enable || '';
  var disable = req.disable || '';
  return strict ? (disable.http2 && !enable.http2) : (disable.h2 && !enable.h2);
};

function isIllegalcHeader(name, value) {
  switch (name) {
  case h2Consts.HTTP2_HEADER_CONNECTION:
  case h2Consts.HTTP2_HEADER_UPGRADE:
  case h2Consts.HTTP2_HEADER_HOST:
  case h2Consts.HTTP2_HEADER_HTTP2_SETTINGS:
  case h2Consts.HTTP2_HEADER_KEEP_ALIVE:
  case h2Consts.HTTP2_HEADER_PROXY_CONNECTION:
  case h2Consts.HTTP2_HEADER_TRANSFER_ENCODING:
    return true;
  case h2Consts.HTTP2_HEADER_TE:
    return value !== 'trailers';
  default:
    return false;
  }
}

exports.formatH2Headers = function(headers) {
  var newHeaders = {};
  Object.keys(headers).forEach(function(name) {
    var value = headers[name];
    if (!isIllegalcHeader(name, value)) {
      newHeaders[name] = value;
    }
  });
  return newHeaders;
};
