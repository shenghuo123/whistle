var Pac = require('node-pac');
var net = require('net');
var LRU = require('lru-cache');
var parseUrl = require('url').parse;
var extend = require('extend');
var parseQuery = require('querystring').parse;
var lookup = require('./dns');
var Rules = require('./rules');
var values = require('./util').values;
var util = require('../util');
var logger = require('../util/logger');
var fileMgr = require('../util/file-mgr');
var config = require('../config');

var tplCache = new LRU({ max: 36 });
var rulesMgrCache = new LRU({ max: 16 });
var rules = new Rules();
var tempRules = new Rules();
var cachedPacs = {};
var VALUE_HEADER = 'x-whistle-rule-value';
var KEY_HEADER = 'x-whistle-rule-key';
var HOST_HEADER = 'x-whistle-rule-host';
var LOCALHOST = '127.0.0.1';
var resolveReqRules = rules.resolveReqRules.bind(rules);

exports.Rules = Rules;
exports.parse = config.networkMode ? util.noop : function(text, root, _inlineValues) {
  if (config.pluginsMode) {
    text = '';
  }
  rules.parse(text, root, _inlineValues);
};
exports.append = rules.append.bind(rules);
exports.resolveHost = rules.resolveHost.bind(rules);
exports.resolveProxy = rules.resolveProxy.bind(rules);
exports.resolveEnable = rules.resolveEnable.bind(rules);
exports.hasReqScript = rules.hasReqScript.bind(rules);
exports.resolveDisable = rules.resolveDisable.bind(rules);
exports.resolvePipe = rules.resolvePipe.bind(rules);
exports.resolveRules = resolveReqRules;
exports.resolveResRules = rules.resolveResRules.bind(rules);
exports.resolveBodyFilter = rules.resolveBodyFilter.bind(rules);
exports.lookupHost = rules.lookupHost.bind(rules);
exports.resolveLocalRule = rules.resolveLocalRule.bind(rules);
exports.clearAppend = rules.clearAppend.bind(rules);

exports.disableDnsCache = function () {
  Rules.disableDnsCache();
};

var dnsResolve = function (host, callback) {
  return lookup(host, callback || util.noop, true);
};
var PROXY_HOSTS_RE = /[?&]proxyHosts?(?:&|$)/i;
var P_HOST_RE = /[?&]host=([\w.:-]+)(?:&|$)/i;

function getProxy(url, req, callback) {
  if (!req) {
    return callback();
  }
  var reqRules = req.rules;
  if (util.isLocalAddress(req.clientIp)) {
    delete req.headers[config.CLIENT_IP_HEAD];
  } else {
    req.headers[config.CLIENT_IP_HEAD] = req.clientIp;
  }
  if (!reqRules) {
    req.curUrl = url;
    return rules.lookupHost(req, callback);
  }

  delete reqRules.proxy;
  delete reqRules.pac;
  req.curUrl = url;
  var pRules = req.pluginRules;
  var fRules = req.rulesFileMgr;
  if (fRules) {
    fRules._values = req._scriptValues;
  }
  var hRules = req.headerRulesMgr;
  var filter = extend(rules.resolveFilter(req),
    pRules && pRules.resolveFilter(req),
    fRules && fRules.resolveFilter(req),
    hRules && hRules.resolveFilter(req));
  var ignoreProxy;
  var proxy = (pRules && pRules.resolveProxy(req)) || rules.resolveProxy(req) ||
    (fRules && fRules.resolveProxy(req)) || (hRules && hRules.resolveProxy(req));
  var proxyHost = util.isEnable(req, 'proxyHost');
  if (proxy) {
    var protocol = proxy.matcher.substring(0, proxy.matcher.indexOf(':'));
    ignoreProxy = !filter['ignore:' + protocol] && (util.isIgnored(filter, 'proxy') || util.isIgnored(filter, protocol));
    if (ignoreProxy) {
      proxy = null;
    } else {
      proxyHost = proxyHost || PROXY_HOSTS_RE.test(proxy.matcher);
    }
  }
  var host = rules.getHost(req, pRules, fRules, hRules);
  var setHost = function() {
    if (!host) {
      return false;
    }
    reqRules.host = host;
    var hostname = util.removeProtocol(host.matcher, true);
    if (!net.isIP(hostname)) {
      req.curUrl = hostname || url;
      return rules.lookupHost(req, function (err, ip) {
        callback(err, ip, host.port, host);
      });
    }
    callback(null, hostname, host.port, host);
    return true;
  };
  if (host) {
    if (proxyHost) {
      req._phost = parseUrl(util.setProtocol(host.matcher + (host.port ? ':' + host.port : '')));
    } else if (!util.isEnable(req, 'proxyFirst')) {
      return setHost();
    }
    proxyHost = true;
  }
  if (ignoreProxy) {
    req.curUrl = url;
    return setHost() || rules.lookupHost(req, callback);
  }
  if (proxy) {
    if (proxy.isInternal) {
      req._phost = null;
    } else if (!req._phost && P_HOST_RE.test(proxy.matcher)) {
      req._phost = parseUrl(util.setProtocol(RegExp.$1));
    }
    reqRules.proxy = proxy;
    return callback();
  }
  var ignorePac = util.isIgnored(filter, 'pac');
  var pacRule = ignorePac ? null : ((pRules && pRules.resolvePac(req)) ||
    rules.resolvePac(req) ||
    (fRules && fRules.resolvePac(req)) ||
    (hRules && hRules.resolvePac(req)));
  if (pacRule) {
    reqRules.pac = pacRule;
  }
  var pacUrl = util.getMatcherValue(pacRule);
  if (!pacUrl) {
    return setHost() || callback();
  }

  var pac = cachedPacs[pacUrl];
  if (pac) {
    delete cachedPacs[pacUrl];
    cachedPacs[pacUrl] = pac;
  } else {
    var list = Object.keys(cachedPacs);
    if (list.length >= 10) {
      delete cachedPacs[list[0]];
    }
    pacUrl = /^https?\:\/\//.test(pacUrl) ? pacUrl : util.join(pacRule.root,
      pacUrl);
    cachedPacs[pacUrl] = pac = new Pac(pacUrl, dnsResolve);
  }
  return pac.findWhistleProxyForURL(url.replace('tunnel:', 'https:'), function (
    err, rule) {
    if (rule) {
      tempRules.parse(pacRule.rawPattern + ' ' + rule);
      req.curUrl = url;
      if (proxy = tempRules.resolveProxy(req)) {
        var protocol = proxy.matcher.substring(0, proxy.matcher.indexOf(':'));
        if (!util.isIgnored(filter, protocol)) {
          reqRules.proxy = proxy;
          reqRules.proxy.raw = pacRule.raw;
        }
      }
    }
    if (reqRules.proxy) {
      (!proxyHost && setHost()) || callback();
    } else {
      req.curUrl = url;
      setHost() || rules.lookupHost(req, callback);
    }
    logger.error(err);
  });
}

exports.getProxy = getProxy;

function tpl(str, data) {
  if (typeof str !== 'string' || str.indexOf('<%') === -1 ||
    str.indexOf('%>') === -1) {
    return str + '';
  }
  var key = str;
  var fn = tplCache.get(key);
  if (!fn) {
    str = str
      .replace(/[\u2028\u2029]/g, '')
      .replace(/\t/g, ' ')
      .replace(/\r?\n|\r/g, '\t')
      .split('<%').join('\u2028')
      .replace(/((^|%>)[^\u2028]*)'/g, '$1\r')
      .replace(/\u2028=(.*?)%>/g, '\',$1,\'')
      .split('\u2028').join('\');')
      .split('%>').join('p.push(\'')
      .split('\r').join('\\\'');
    try {
      fn = new Function('obj',
        'var p=[],print=function(){p.push.apply(p,arguments);};' +
        'with(obj){p.push(\'' + str + '\');}return p.join(\'\');');
    } catch (e) {
      fn = e;
      throw e;
    } finally {
      tplCache.set(key, fn);
    }
  } else if (typeof fn !== 'function') {
    throw fn;
  }
  return fn(data || {}).replace(/\t/g, '\n');
}

function getScriptContext(req, res, body, pattern) {
  var ip = req.clientIp || LOCALHOST;
  var ctx = req.scriptContenxt;
  if (!ctx) {
    var headers = extend(true, {}, req.headers);
    ctx = req.scriptContenxt = {
      pattern: pattern,
      version: config.version,
      port: config.port,
      uiHost: 'local.wproxy.org',
      uiPort: config.uiport,
      url: req.fullUrl,
      method: util.toUpperCase(req.method) || 'GET',
      httpVersion: req.httpVersion || '1.1',
      isLocalAddress: function (_ip) {
        return util.isLocalAddress(_ip || ip);
      },
      ip: ip,
      clientIp: ip,
      clientPort: req.clientPort,
      headers: headers,
      reqHeaders: headers,
      body: body || '',
      reqScriptData: {},
      res: null
    };
  }
  ctx.rules = [];
  ctx.values = {};
  ctx.value = req.globalValue;
  ctx.getValue = values.get;
  ctx.parseUrl = parseUrl;
  ctx.parseQuery = parseQuery;
  ctx.tpl = ctx.render = tpl;
  if (res) {
    ctx.statusCode = res.statusCode;
    ctx.serverIp = req.hostIp || LOCALHOST;
    ctx.resHeaders = extend(true, {}, res.headers);
  } else {
    ctx.statusCode = '';
    ctx.serverIp = '';
    ctx.resHeaders = '';
  }
  return ctx;
}

function getReqPayload(req, res, cb) {
  if (res) {
    return cb();
  }
  if (req.getPayload && util.hasRequestBody(req)) {
    if (typeof req._reqBody === 'string') {
      cb(req._reqBody);
    } else {
      req.getPayload(function (_, payload) {
        cb(fileMgr.decode(payload));
      });
    }
  } else {
    cb();
  }
}

function execRulesScript(script, req, res, body, pattern) {
  var context = getScriptContext(req, res, body, pattern);
  if (util.execScriptSync(script, context) && Array.isArray(context.rules)) {
    return {
      rules: context.rules.join('\n').trim(),
      values: context.values
    };
  }
  return '';
}
exports.execRulesScript = execRulesScript;

function handleDynamicRules(script, req, res, cb) {
  util.getRuleValue(script, function (list) {
    var scriptItem, index, text;
    if (list) {
      index = script.scriptIndex;
      scriptItem = script.list[index];
      text = scriptItem && list[index];
    }
    if (!scriptItem || util.isRulesContent(text)) {
      return cb(list && list.join('\n'));
    }
    getReqPayload(req, res, function(body) {
      var result = execRulesScript(text, req, res, body, script.rawPattern);
      list[index] = result.rules;
      cb(list.join('\n'), result.values);
    });
  });
}

function resolveRulesFile(req, callback) {
  req.globalValue = util.getMatcherValue(req.rules.G, true);
  handleDynamicRules(req.rules.rulesFile, req, null, function(text, vals) {
    if (text) {
      var rulesFileMgr = rulesMgrCache.get(text);
      if (!rulesFileMgr) {
        rulesFileMgr = new Rules(vals);
        rulesFileMgr.parse(text);
        rulesMgrCache.set(text, rulesFileMgr);
      }
      rulesFileMgr._values = vals;
      req._scriptValues = vals;
      req.rulesFileMgr = rulesFileMgr;
      req.curUrl = req.fullUrl;
      text = req.rulesFileMgr.resolveRules(req);
    }
    // 不能放到if里面
    util.mergeRules(req, text);
    callback();
  });
}

exports.resolveRulesFile = resolveRulesFile;
exports.resolveResRulesFile = function(req, res, callback) {
  handleDynamicRules(req.rules && req.rules.resScript, req, res, function(text, vals) {
    text = text && text.trim();
    callback(text && {
      text: text,
      values: vals
    });
  });
};

function initHeaderRules(req, needBodyFilters) {
  if (req._bodyFilters !== undefined) {
    return;
  }
  req._bodyFilters = null;
  var headers = req.headers;
  var valueHeader = headers[VALUE_HEADER];
  var hostHeader = headers[HOST_HEADER];
  var keyHeader = headers[KEY_HEADER];
  req.rulesHeaders = {};
  if (valueHeader) {
    if (config.strict) {
      valueHeader = null;
    } else {
      req.rulesHeaders[VALUE_HEADER] = valueHeader;
    }
    delete headers[VALUE_HEADER];
  }
  if (hostHeader) {
    if (config.strict) {
      hostHeader = null;
    } else {
      req.rulesHeaders[HOST_HEADER] = hostHeader;
    }
    delete headers[HOST_HEADER];
  }
  if (keyHeader) {
    if (config.strict) {
      keyHeader = null;
    } else {
      req.rulesHeaders[KEY_HEADER] = keyHeader;
    }
    delete headers[KEY_HEADER];
  }
  var ruleValue = util.trimStr(valueHeader);
  var host = util.trimStr(hostHeader);
  if (host) {
    ruleValue = ruleValue + '\n' + host;
  }
  if (ruleValue) {
    try {
      ruleValue = decodeURIComponent(ruleValue).trim();
    } catch (e) {}
  }
  var ruleKey = util.trimStr(keyHeader);
  try {
    ruleKey = decodeURIComponent(ruleKey);
  } catch (e) {}
  if (ruleKey) {
    ruleKey = util.trimStr(values.get(ruleKey));
    if (ruleKey) {
      ruleValue = ruleKey + '\n' + ruleValue;
    }
  }
  if (ruleValue) {
    var rulesMgr = new Rules();
    rulesMgr.parse(ruleValue);
    req.headerRulesMgr = rulesMgr;
    var bodyFilters = needBodyFilters && rulesMgr._rules._bodyFilters;
    if (bodyFilters && bodyFilters.length) {
      req._bodyFilters = rules._rules._bodyFilters.concat(bodyFilters);
    }
  }
}

exports.initHeaderRules = initHeaderRules;

function initRules(req) {
  var fullUrl = req.fullUrl || util.getFullUrl(req);
  req.curUrl = fullUrl;
  initHeaderRules(req);
  if (req.headerRulesMgr) {
    req.rules = req.headerRulesMgr.resolveRules(req);
    util.mergeRules(req, resolveReqRules(req));
  } else {
    req.rules = resolveReqRules(req);
  }
  return req.rules;
}

exports.initRules = initRules;
