#!/usr/bin/env node

"use strict"

const proc = require('child_process');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');
const zlib = require('zlib');

function init_plugins(module, plugins_dir) {
  fs.readdirSync(plugins_dir).forEach((plugin => {
    if(fs.statSync(path.join(plugins_dir, plugin, 'index.js')).isFile()) {
      try {
        module.exports.plugins[plugin] = require(path.join(plugins_dir, plugin, 'index.js'));
      } catch (err) {
        console.log(module.exports.terminal.markdown(`\n !!▸!! error loading plugin "${plugin}": ${err}\n`));
      }
      if(module.exports.plugins[plugin] && module.exports.plugins[plugin].init) {
        try {
          module.exports.plugins[plugin].init(module.exports);
        } catch (err) {
          console.log(module.exports.terminal.markdown(`\n !!▸!! error initializing plugin "${plugin}": ${err}\n`));
        }
      }
    }
  }));
}

function get_home() {
  return process.env[(process.platform == 'win32') ? 'USERPROFILE' : 'HOME'];
}

function create_dir(directory) {
  let stats = null;
  try {
    stats = fs.statSync(directory);
  } catch (e) {
    try {
      fs.mkdirSync(directory);
      stats = fs.statSync(directory);
    } catch (e) {
      console.error(`The plugins directory cannot be accessed, could not be created, or is a file (${directory}).`);
      return null;
    }
  }
}

// Initialize, setup any items at runtime
module.exports.init = function init() {

  if(!process.env.AKKERIS_API_HOST || !process.env.AKKERIS_AUTH_HOST) {
    console.error()
    console.error("!!! Akkeris cannot find environment variables AKKERIS_API_HOST and AKKERIS_AUTH_HOST")
    console.error("    set these using export AKKERIS_API_HOST=... and export AKKERIS_AUTH_HOST=...")
    console.error("    or add it to your .profile. If you do not know these values ask someone!")
    console.error()
    process.exit(1)
  }
  // Set common dir paths
  let akkeris_home = path.join(get_home(), '.akkeris')
  let akkeris_plugins = path.join(get_home(), '.akkeris', 'plugins')
  let akkeris_base_plugins = path.join(path.dirname(module.filename), 'plugins')

  // Create necessary directories
  create_dir(akkeris_home)
  create_dir(akkeris_plugins)
  create_dir(akkeris_base_plugins)

  module.exports.config = {
    plugins_dir:null, 
    akkeris_api_host:(process.env.AKKERIS_API_HOST),
    akkeris_auth_host:(process.env.AKKERIS_AUTH_HOST),
    package:JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json').toString('utf8')))
  };
  module.exports.terminal = require(path.join(__dirname, 'lib', 'terminal.js'))
  

  // Establish the base arguments for the CLI.
  module.exports.args = require('yargs')
    .usage('Usage: appkit COMMAND [--app APP] [command-specific-options]')
    .command('update', 'update the appkit client', {}, module.exports.update.bind(null, module.exports))
    .command('version', 'display version', {}, module.exports.version.bind(null, module.exports))
    .command('completion', 'show appkit auto-completion script (e.g, "ak completion >> ~/.bash_profile").', {}, () => {
      module.exports.args.showCompletionScript();
    })
    .recommendCommands()
  // map cli width for yargs
  module.exports.args.wrap(module.exports.args.terminalWidth())
  module.exports.random_tips = [
    '🚀  Fun tip! You can use "latest" rather than a specific ID for builds and releases when getting info.',
  ];

  // load plugins
  module.exports.plugins = {};
  module.exports.config.plugins_dir = path.join(path.dirname(module.filename), 'plugins')
  module.exports.config.third_party_plugins_dir = path.join(get_home(), '.akkeris', 'plugins')
  require('./lib/plugins.js').init(module.exports.args, module.exports);

  console.assert(module.filename, 'No module.filename exists, no clue where we are. This is a very odd error.');
  
  // Scan and initialize the plugins as needed.
  init_plugins(module, module.exports.config.plugins_dir)
  init_plugins(module, module.exports.config.third_party_plugins_dir)
  
  // Grab netrc info
  const netrc = require('netrc')();
  module.exports.account = netrc[module.exports.config.akkeris_api_host];
}

module.exports.version = function version(appkit, args) {
  console.log("akkeris/" + appkit.config.package.version + " " + process.arch + "-" + process.platform + " node-" +process.version);
  console.log(appkit.terminal.markdown(`###===### Installed Plugins`));
  Object.keys(module.exports.plugins).forEach((plugin) => {
    console.log(module.exports.plugins[plugin].group + " " + (module.exports.plugins[plugin].version ? "@" + module.exports.plugins[plugin].group : ""))
  });
}

// Update our dependencies and our plugins as needed.
module.exports.update = function update(appkit) {
  console.assert(appkit.config.third_party_plugins_dir, 'Update was ran without init being ran first, everything is empty.');
  fs.readdirSync(appkit.config.third_party_plugins_dir).forEach((plugin => {
    try {
      if(fs.statSync(path.join(appkit.config.third_party_plugins_dir, plugin, '.git')).isDirectory()) {
        console.log(appkit.terminal.markdown(`###===### updating ${plugin} plugin`));
        proc.spawnSync('git',['pull', '--quiet'], {cwd:path.join(appkit.config.third_party_plugins_dir, plugin), env:process.env, stdio:'inherit'});
        if(fs.statSync(path.join(appkit.config.third_party_plugins_dir, plugin, 'index.js')).isFile()) {
          if(module.exports.plugins[plugin].update) {
            try {
              require(path.join(appkit.config.third_party_plugins_dir, plugin, 'index.js')).update(module.exports);
            } catch (err) {
              console.log(appkit.terminal.markdown(` !!▸!! error updating plugin "${plugin}": ${err}`));
            }
          }
        }
      }
    } catch (e) {
      // skip.
      if(process.env.NODE_DEBUG) {
        console.info(e);
      }
    }
  }));
  console.log(appkit.terminal.markdown(`###===### updating appreciatekit`));
  proc.spawnSync('git',['pull', '--quiet'], {cwd:__dirname, env:process.env, stdio:'inherit'});
  proc.spawnSync('npm',['install'], {cwd:__dirname, env:process.env, stdio:'inherit'});
}

function is_redirect(type, res) { return type.toLowerCase() === 'get' && res.headers['location'] && (res.statusCode === 301 || res.statusCode === 302); }
function is_response_ok(res) { return res.statusCode > 199 && res.statusCode < 300 ? true : false; }
function response_body(type, callback, res) {
  let body = new Buffer(0);
  res.on('data', (e) => body = Buffer.concat([body,e]) );
  res.on('end', (e) => {
    if(is_redirect(type, res)) {
      get(res.headers['location'], headers, callback);
    } else if(is_response_ok(res)) {
      if(res.headers['content-encoding'] === 'gzip') {
        body = zlib.gunzipSync(body);
      }
      callback(null, res.headers['content-type'] === 'application/zip' ? body : body.toString('utf8'), res.headers);
    } else {
      callback({code:res.statusCode, body:body, headers:res.headers}, null);
    } 
  });
}

function request(type, payload, rurl, headers, callback) {
  let connector = rurl.startsWith('http://') ? http : https;
  let opts = url.parse(rurl);
  opts.method = type;
  opts.headers = headers || {};

  let req = connector.request(opts, response_body.bind(null, type, (e, d) => { 
    if(d) {
      d = JSON.parse(d)
    }
    callback(e,d);
  }));
  if(payload) {
    req.write(payload);
  }
  req.on('error', (err) => { callback(err); });
  req.end();
}

function appkit_request(type, payload, rurl, callback) {
  let headers = {};
  headers['content-type'] = headers['content-type'] || 'application/json';
  if(module.exports.account && module.exports.account.password) {
    headers['authorization'] = 'Bearer ' + module.exports.account.password;
  }
  if(module.exports.args && module.exports.args.argv && module.exports.args.argv.authtoken) {
    headers['authorization'] = 'Bearer ' + module.exports.args.argv.authtoken;
  }
  // Override for bearer token
  if(process.env.API_TOKEN) {
    headers['authorization'] = 'Bearer ' + process.env.API_TOKEN;
  }
  // Override if shared-secret is used
  if(process.env.API_AUTH) {
    headers['authorization'] = process.env.API_AUTH;
  }

  headers['user-agent'] = 'appkit-cli';

  let full_url = rurl.startsWith("http") ? rurl : 
                ( (module.exports.config.akkeris_api_host.startsWith("http") ? 
                    module.exports.config.akkeris_api_host : 
                    'https://' + module.exports.config.akkeris_api_host) + rurl);

  request(type, payload, full_url, headers, callback);
}

module.exports.http = {
  get:request.bind(null, 'get', null),
  post:request.bind(null, 'post'),
  patch:request.bind(null, 'patch'),
  delete:request.bind(null, 'delete', null),
  put:request.bind(null, 'put')
}

module.exports.api = {
  get:appkit_request.bind(null, 'get', null),
  post:appkit_request.bind(null, 'post'),
  patch:appkit_request.bind(null, 'patch'),
  delete:appkit_request.bind(null, 'delete', null),
  put:appkit_request.bind(null, 'put')
}

if(require.main === module) {
  module.exports.init();
  module.exports.args
    .strict()
    .demand(1)
    .epilog(
      module.exports.random_tips[Math.floor(module.exports.random_tips.length * Math.random())]
    )
    .argv
}
