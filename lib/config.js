#!/usr/bin/env node

var dir = require('node-dir')
var path = require('path')
var fs = require('fs')
var pointer = require('json-pointer')
var validator = require('is-my-json-valid')
var shelljs = require('shelljs')
var extend = require('extend')
var crypto = require('crypto')
var moment = require('moment')

function deepcopy (o) {
  return extend(true, {}, o)
}

exports.hasObjectPattern = function (config, pattern) {
  var isPattern = exports.createMatcher(pattern)
  var found = false
  function traverse (o) {
    for (var i in o) {
      if (isPattern(o[i])) {
        found = true
      }

      if (o[i] !== null && typeof (o[i]) === 'object') {
        // going on step down in the object tree!!
        traverse(o[i])
      }
    }
  }

  traverse(config)
  return found
}

exports.createConfigFilter = function (config, options) {
  options = deepcopy(options)
  options.benchmarks = options.benchmarks || config['benchmark-list']
  options.implementations = options.implementations || config['implementation-list']
  options.compilers = options.compilers || config['compiler-list']
  options.environments = options.environments || config['environment-list']

  return function (c) {
    if (options.benchmarks.length > 0 &&
      options.benchmarks.indexOf(c.benchmark['short-name']) < 0) {
      return false
    }

    if (options.implementations.length > 0 &&
      options.implementations.indexOf(c.implementation['short-name']) < 0) {
      return false
    }

    if (options.compilers.length > 0 &&
      options.compilers.indexOf(c.compiler['short-name']) < 0) {
      return false
    }

    if (options.environments.length > 0 &&
      options.environments.indexOf(c.environment['short-name']) < 0) {
      return false
    }

    return true
  }
}

// Validate the configuration schema first
var configSchemaPath = path.join(__dirname, '/config-schema.json')
var configSchemaString = fs.readFileSync(configSchemaPath)
var configSchema
try {
  configSchema = JSON.parse(configSchemaString)
} catch (e) {
  throw new Error("Configuration schema '" + configSchemaPath + "' is invalid JSON. Try jsonlint.com to fix it.")
}

var validateJSONSchemaV4 = validator(
  JSON.parse(fs.readFileSync(path.join(__dirname, '/schema.json'))),
  {
    greedy: true,
    verbose: true
  })
validateJSONSchemaV4(configSchema)
if (validateJSONSchemaV4.errors !== null) {
  throw new Error(validateJSONSchemaV4.errors)
}

function getConfigFromFileSystem (dirRoot, cb) {
  var validateConfig = validator(
    configSchema,
    {
      greedy: true,
      verbose: true
    })

  var types = pointer.get(configSchema, '/config-type-name-list')
  var collections = types.map(function (s) { return s + 's' })
  var shortNamePattern = configSchema.definitions['short-name'].pattern.slice(1, -1)
  var pathParser = new RegExp('(' + collections.join('|') + ')\/' + shortNamePattern, 'g')

  function keepConfigPaths (paths) {
    return paths.filter(function (file) {
      return file.match(RegExp('(' + types.join('|') + ').json$'))
    })
  }

  function parseConfig (p) {
    try {
      var config = JSON.parse(fs.readFileSync(p))
      validateConfig(config)
      if (validateConfig.errors !== null) {
        cb(validateConfig.errors, {})
      }
    } catch (e) {
      cb("Invalid JSON in '" + p + "':\n" + e.toString(), {})
    }
    return config
  }

  function validateSemantics (config) {
    function error (msg) {
      return {
        'error': 'Semantic Validation Error',
        'message': msg
      }
    }

    // 1. Ensure a benchmark has at least one implementation
    for (var b in config.benchmarks) {
      if (!config.benchmarks[b].hasOwnProperty('implementations') ||
        Object.keys(config.benchmarks[b].implementations).length < 1) {
        return error("Benchmark '" + b + "' has no implementation folder or 'implementation.json' description file")
      }
    }

    return null
  }

  function addLocation (node, p) {
    node.location = path.dirname(p)
    return node
  }

  function importConfig (older, newer) {
    for (var p in newer) {
      older[p] = newer[p]
    }
  }

  function parsePath (p) {
    var r = p.match(pathParser)
    if (r === null) {
      throw new Error("Invalid path '" + p + "'")
    }
    return r.map(function (s) { return s.split('/') })
  }

  function computeList (config, key, resultKey) {
    var list = []
    for (var k in config[key]) {
      list.push(k)
    }
    config[resultKey] = list
  }

  function computeImplementationList (config) {
    var implementations = {}
    for (var b in config.benchmarks) {
      for (var i in config.benchmarks[b].implementations) {
        implementations[i] = true
      }
    }

    var list = []
    for (i in implementations) {
      list.push(i)
    }

    config['implementation-list'] = list
  }

  function updateGlobalConfig (config, json) {
    var configPath = parsePath(json.location)
    var node = config

    configPath.forEach(function (pair) {
      var collectionName = pair[0]
      var shortName = pair[1]

      if (collections.indexOf(collectionName) < 0) {
        return new Error("Invalid collection '" + collectionName + "'")
      }

      var collection = node[collectionName] || (node[collectionName] = {})
      node = collection[shortName] || (collection[shortName] = {'short-name': shortName})
    })

    importConfig(node, json)
    return null
  }

  var validateRelativePath = validator(
    pointer.get(configSchema, '/definitions/relative-path'))

  function isRelativePath (o) {
    validateRelativePath(o)
    return validateRelativePath.errors === null
  }

  var validateSuiteRootPath = validator(
    pointer.get(configSchema, '/definitions/suite-root-path'))

  function isSuiteRootPath (o) {
    validateSuiteRootPath(o)
    return validateSuiteRootPath.errors === null
  }

  function resolvePaths (config) {
    function traverse (o, location) {
      if (o.hasOwnProperty('location')) {
        location = o.location
      }

      for (var i in o) {
        if (location) {
          if (isRelativePath(o[i])) {
            o[i] = path.join(location, o[i])
          } else if (isSuiteRootPath(o[i])) {
            o[i] = { 'file': path.join(dirRoot, o[i]['suite-root']) }
          }
        }

        if (o[i] !== null && typeof (o[i]) === 'object') {
          // going on step down in the object tree!!
          traverse(o[i], location)
        }
      }
    }

    traverse(config, null)
  }

  function resolveExecutablePaths (config) {
    function traverse (o, location) {
      if (o.hasOwnProperty('executable-name')) {
        if (!o.hasOwnProperty('executable-path')) {
          var suitePath = path.join(location, o['executable-name'])
          var systemPath = shelljs.which(o['executable-name'])
          if (shelljs.test('-e', suitePath)) {
            o['executable-path'] = suitePath
          } else if (systemPath !== null) {
            o['executable-path'] = systemPath
          } else {
            cb("Could not resolve executable path for compiler '" +
              o['executable-name'] + '' + "' specified in " + location, null)
            process.exit(1)
          }
        }
      }

      for (var i in o) {
        if (o[i] !== null && typeof (o[i]) === 'object') {
          // going on step down in the object tree!!
          traverse(o[i], o[i].hasOwnProperty('location') ? o[i].location : location)
        }
      }
    }

    traverse(config, dirRoot)
  }

  dir.files(dirRoot, function (err, files) {
    if (err) cb(err, null)

    var globalConfig = {}

    keepConfigPaths(files).forEach(function (p) {
      var config = parseConfig(p)
      err = updateGlobalConfig(globalConfig, addLocation(config, p))
      if (err) {
        cb(err, null)
        process.exit(1)
      }
    })
    err = validateSemantics(globalConfig)
    if (err) {
      cb(err, null)
      process.exit(1)
    }

    computeList(globalConfig, 'benchmarks', 'benchmark-list')
    computeList(globalConfig, 'compilers', 'compiler-list')
    computeList(globalConfig, 'environments', 'environment-list')
    computeImplementationList(globalConfig)

    resolvePaths(globalConfig)
    resolveExecutablePaths(globalConfig)

    globalConfig.schema = configSchema

    cb(null, globalConfig)
  })
}

exports.config = getConfigFromFileSystem
exports.createMatcher = function (p) {
  var schemaCopy = deepcopy(configSchema)
  var matcher = null
  if (typeof p === 'string') {
    if (!pointer.has(configSchema, p)) {
      throw new Error('Invalid pointer ' + p + ' for matcher')
    }
    schemaCopy.oneOf = [ {'$ref': '#' + p} ]
    matcher = validator(schemaCopy)
  } else if (typeof p === 'object') {
    matcher = validator(p)
  } else {
    throw new Error("Invalid argument for createMatcher :'" + p + "'")
  }

  return function (o) {
    matcher(o)
    return matcher.errors === null
  }
}

var isResolvedValue = exports.createMatcher('/definitions/resolved-value')
var isFilePath = exports.createMatcher('/definitions/file-path')
var macros = {
  '/experiment/input-size': function (config, v, options) {
    return {
      'config': path.join('/benchmark/input-size', v.expand, v.path ? v.path : '')
    }
  },
  '/experiment/input-file': function (config, v, options) {
    var silentState = shelljs.config.silent
    shelljs.config.silent = true
    var cmd = path.join(config.benchmark.location, '/input/get') + ' ' + v.expand[0] + ' ' + v.expand[1]
    var status = shelljs.exec(cmd)
    shelljs.config.silent = silentState

    if (status.code !== 0) {
      throw new Error('Expand input-file: Execution error for ' + cmd + ':')
    }

    var filePath = {
      'file': status.output
    }

    if (!isFilePath(filePath)) {
      // Be lenient with file path output including a trailing newline
      var m = filePath.file.match('(.*)\n+$')
      if (m) {
        var cleanFilePath = {
          'file': m[1]
        }
        if (isFilePath(cleanFilePath)) {
          return cleanFilePath
        }
        filePath = cleanFilePath
      }

      throw new Error("Invalid output from '" + cmd + "', expected a file path, instead got:\n'" + status.output + "'")
    }

    return filePath
  },
  '/definitions/expandable-reference': function (config, v, options) {
    if (!pointer.has(config, v.expand)) {
      if (options.strict) {
        throw new Error('could not find expandable reference: ' + v.expand)
      }
      return v
    }

    if (options.macros.hasOwnProperty(v.expand)) {
      var resolved = {}
      for (var p in v) {
        if (p === 'expand') {
          resolved.expand = options.traverse(pointer.get(config, v.expand))
        } else {
          resolved[p] = v[p]
        }
      }
      return options.macros[v.expand](config, resolved, options)
    } else {
      return v
    }
  },
  '/definitions/configuration-reference': function (config, v, options) {
    var optional = v.hasOwnProperty('optional') && v.optional === true
    if (pointer.has(config, v.config)) {
      return pointer.get(config, v.config)
    } else {
      if (options.strict && !optional) {
        throw new Error('Invalid reference to ' + v.config)
      } else {
        if (optional) {
          return []
        } else {
          return v
        }
      }
    }
  },
  '/definitions/file-path-object': function (config, v, options) {
    return v.file
  },
  '/definitions/prefix-object': function (config, v, options) {
    if (isResolvedValue(v.value)) {
      var value = v.value
      if (Array.prototype.isPrototypeOf(value)) {
        return value.map(function (s) {
          return v.prefix + s
        })
      } else {
        return v.prefix + value
      }
    } else {
      return v
    }
  }
}

exports.expand = function (config, options) {
  var option_defaults = {
    'strict': false,
    'macros': macros
  }
  options = options || {}
  options.strict = options.strict || option_defaults.strict

  // Macro expansions maybe be either listed in an array to use
  // the default definitions or completely specified using functions
  // by following the calling protocol
  if (options.hasOwnProperty('macros')) {
    if (Array.prototype.isPrototypeOf(options.macros)) {
      for (var i = 0; i < options.macros.length; ++i) {
        var dict = {}
        var p = options.macros[i]
        if (macros.hasOwnProperty(p)) {
          dict[p] = option_defaults.macros[p]
        }
      }
      options.macros = dict
    }
  } else {
    options.macros = option_defaults.macros
  }

  // Just-In-Time dispatcher for macro expansion,
  // performance may be improved by code generation
  // using a switch case rather than linear search
  // through an array
  var dispatch = (function (config, options) {
    var match = []
    var pointer = []
    for (var p in options.macros) {
      if (p.match(/^\/definitions\//)) {
        match.push(exports.createMatcher(p))
        pointer.push(p)
      }
    }
    return function (v) {
      for (var i = 0; i < match.length; ++i) {
        if (match[i](v)) {
          return options.macros[pointer[i]](config, v, options)
        }
      }
      return v
    }
  })(config, options)

  // Bottom-up tree rewriting with fixed-point expansion
  function traverse (o) {
    for (var i in o) {
      var v = o[i]
      if (v !== null && typeof (v) === 'object') {
        traverse(v)
      }
      var before = v
      var after = null
      while (true) {
        after = dispatch(before)
        if (JSON.stringify(before) === JSON.stringify(after)) {
          break
        }
        before = after
      }
      o[i] = after
    }

    return o
  }

  options.traverse = traverse
  traverse(config)
}

function flattenArray (array) {
  function recurse (a) {
    for (var i = 0; i < a.length; ++i) {
      var v = a[i]
      if (Array.prototype.isPrototypeOf(v)) {
        recurse(v)
      } else {
        flat.push(v)
      }
    }
  }

  if (Array.prototype.isPrototypeOf(array)) {
    var flat = []
    recurse(array)
    return flat
  } else {
    return array
  }
}
exports.flattenArray = flattenArray

// Extract short-name(s) from position arguments
exports.extractShortNames = function (config, parsed) {
  parsed.benchmarks = (parsed.benchmark || []).slice(0)
  parsed.compilers = (parsed.compiler || []).slice(0)
  parsed.implementations = (parsed.implementation || []).slice(0)
  parsed.environments = (parsed.environment || []).slice(0)

  parsed.argv.remain.forEach(function (n) {
    function isAmbiguous () {
      if (matched) {
        console.log("'" + n + "' matches multiple categories, specify its category with a flag.")
        process.exit(1)
      } else {
        matched = true
      }
    }
    var matched = false
    var categories = [
      'benchmark',
      'compiler',
      'implementation',
      'environment'
    ]

    categories.forEach(function (c) {
      if (config[c + '-list'].indexOf(n) > -1) {
        parsed[c + 's'].push(n)
        isAmbiguous()
      }
    })

    if (!matched) {
      console.log("invalid short-name '" + n + "', available short-name(s):")
      categories.forEach(function (c) {
        console.log('  ' + c + 's: ' + config[c + '-list'])
      })
      process.exit(1)
    }
  })
  return parsed
}

function combinations () {
  function copy (a) {
    var c = []
    for (var i = 0; i < a.length; ++i) {
      c.push(a[i])
    }
    return c
  }
  var comb = [[]]
  var newRow

  for (var i = 0; i < arguments.length; ++i) {
    var newComb = []
    for (var j = 0; j < comb.length; ++j) {
      if (Array.prototype.isPrototypeOf(arguments[i])) {
        for (var k = 0; k < arguments[i].length; ++k) {
          newRow = copy(comb[j])
          newRow.push(arguments[i][k])
          newComb.push(newRow)
        }
      } else {
        newRow = copy(comb[j])
        newRow.push(arguments[i])
        newComb.push(newRow)
      }
    }
    comb = newComb
  }
  return comb
}

exports.genBuildConfigurations = function (config, options) {
  options = options || {}

  options.benchmarks = options.benchmarks || config['benchmark-list']
  options.implementations = options.implementations || config['implementation-list']
  options.compilers = options.compilers || config['compiler-list']

  var suiteRoot = options.suiteRoot || exports.findRootDirectoryPath(process.cwd(), '.wu')

  function invalid (buildConfig) {
    return null
  }

  function resolveBuildConfig (config, b, i, c, cb) {
    function error (msg) {
      return {
        'error': 'Build Configuration Resolution Error',
        'msg': msg
      }
    }

    var buildConfig = {
      'type': 'build',
      'benchmark': {},
      'implementation': {},
      'compiler': {}
    }

    if (!config.benchmarks.hasOwnProperty(b)) {
      cb(error("No benchmark '" + b + "' in configuration"), null)
    }
    extend(true, buildConfig.benchmark, config.benchmarks[b])

    if (config.hasOwnProperty('implementations') &&
      config.implementations.hasOwnProperty(i)) {
      extend(true, buildConfig.implementation, config.implementations[i])
    }

    if (config.hasOwnProperty('compilers') &&
      config.compilers.hasOwnProperty(c)) {
      extend(true, buildConfig.compiler, config.compilers[c])
    }

    if (config.benchmarks[b].hasOwnProperty('implementations') &&
      config.benchmarks[b].implementations.hasOwnProperty(i)) {
      extend(
        true,
        buildConfig.implementation,
        config.benchmarks[b].implementations[i]
      )

      if (config.benchmarks[b].implementations[i].hasOwnProperty('compilers') &&
        config.benchmarks[b].implementations[i].compilers.hasOwnProperty(c)) {
        extend(
          true,
          buildConfig.compiler,
          config.benchmarks[b].implementations[i].compilers[c]
        )
      }
    }

    if (config.compilers.hasOwnProperty(c) &&
      config.compilers[c].hasOwnProperty('benchmarks') &&
      config.compilers[c].benchmarks.hasOwnProperty(b)) {
      extend(
        true,
        buildConfig.benchmark,
        config.compilers[c].benchmarks[b]
      )

      if (config.compilers[c].benchmarks[b].hasOwnProperty('implementations') &&
        config.compilers[c].benchmarks[b].implementations.hasOwnProperty(i)) {
        extend(
          true,
          buildConfig.implementation,
          config.compilers[c].benchmarks[b].implementations[i]
        )
      }
    }

    delete buildConfig.benchmark.implementations
    delete buildConfig.compiler.benchmarks
    delete buildConfig.implementation.compilers

    exports.expand(buildConfig)

    buildConfig.compiler.commands.forEach(function (c) {
      c.options = exports.flattenArray(c.options)
    })

    if (invalid(buildConfig)) {
      cb(error(invalid(buildConfig)))
    }

    cb(null, buildConfig)
  }

  function valid (c) {
    var benchmark = config.benchmarks[c[0]]
    var implementationName = c[1]
    var implementation = benchmark.implementations[implementationName]
    var compiler = config.compilers[c[2]]
    return (benchmark.implementations.hasOwnProperty(implementationName) &&
    compiler['supported-languages'].indexOf(implementation.language) >= 0)
  }

  function computeBuildDirectoryName (config) {
    var hash = crypto.createHash('sha1')
    hash.update(JSON.stringify(config))
    return hash.digest('hex')
  }

  var buildConfigs = combinations(
    options.benchmarks,
    options.implementations,
    options.compilers
  ).filter(valid).map(function (row) {
    var result
    resolveBuildConfig(
      config,
      row[0],
      row[1],
      row[2],
      function (err, config) {
        if (err) {
          console.log(err)
          process.exit(1)
        }

        result = config
      }
    )
    result.location = path.join(suiteRoot, 'builds', computeBuildDirectoryName(result))
    return result
  })

  return buildConfigs
}

exports.createBuildCompilationCommands = function (config) {
  return config.compiler.commands.map(function (cmd) {
    var options = cmd.options.map(function (o) {
      return '        ' + ((typeof o === 'object') ? '<unresolved ' + JSON.stringify(o) + ' >' : o)
    })

    return '    ' + cmd['executable-path'] + '\\\n' + options.join('\\\n')
  })
}

exports.createRunner = function (config, parsed) {
  if (parsed.verbose) {
    console.log(
      'creating ' + config.compiler['runner-name'] +
      ' for ' + config.benchmark['short-name'] +
      ' from ' + config.implementation['short-name'] + ' implementation' +
      ' using ' + config.compiler['short-name'] + ' compiler')
    console.log('result saved in ' + config.location)
  }
  var silentState = shelljs.config.silent
  shelljs.config.silent = true
  shelljs.mkdir('-p', config.location)
  shelljs.pushd(config.location)

  config.compiler.commands.forEach(function (c, i) {
    var cmd = c['executable-path'] + ' ' + c.options.join(' ')
    var status = shelljs.exec(cmd,
      {silent: !parsed.verbose})
    status.output.to('log-' + i + '.txt')

    if (status.code !== 0) {
      console.log('Build error for ' + config.benchmark['short-name'] + "'s " +
        config.implementation['short-name'] + ' implementation ' +
        ' using ' + config.compiler['short-name'] + ' compiler,' +
        ' when executing: \n' + cmd)
      console.log(status.output)
      process.exit(1)
    }
  })
  config.time = new Date()
  JSON.stringify(config, null, '  ').to('build.json')
  shelljs.popd()
  shelljs.config.silent = silentState
}

exports.genRunConfigurations = function (config, options) {
  options = deepcopy(options) || {}

  options.benchmarks = options.benchmarks || config['benchmark-list']
  options.implementations = options.implementations || config['implementation-list']
  options.compilers = options.compilers || config['compiler-list']
  options.environments = options.environments || config['environment-list']

  options.experiment = options.experiment || {}
  options.experiment['type'] = 'experiment'
  options.experiment['input-size'] = options.experiment['input-size'] || 'medium'
  options.experiment['iteration-number'] = options.experiment['iteration-number'] || 1
  options.experiment['short-name'] = options.experiment['short-name'] || 'default'

  var suiteRoot = options.root || exports.findRootDirectoryPath(process.cwd(), '.wu')

  var builds = options.builds ? options.builds : exports.genBuildConfigurations(config, options)

  if (!options.platform) {
    var setupPath = path.join(suiteRoot, '.wu', 'setup.json')
    options.platform = JSON.parse(fs.readFileSync(setupPath)).platform

    if (!config.platforms.hasOwnProperty(options.platform)) {
      console.log("Invalid platform specified in '.wu/setup.json'")
      process.exit(1)
    }
  }

  function valid (compiler, environment) {
    var targetLanguages = compiler['target-languages']
    var supportedLanguages = environment['supported-languages']

    var validLanguage = false
    for (var i = 0; i < targetLanguages.length; ++i) {
      for (var j = 0; j < supportedLanguages.length; ++j) {
        validLanguage = validLanguage || (targetLanguages[i] === supportedLanguages[j])
      }
    }
    return validLanguage
  }

  var runConfigs = []
  builds.forEach(function (buildConfig) {
    options.environments.forEach(function (envName) {
      var environment = deepcopy(config.environments[envName])

      if (!valid(buildConfig.compiler, environment)) {
        return
      }

      var runConfig = deepcopy(buildConfig)
      runConfig.environment = environment
      runConfig.platform = deepcopy(config.platforms[options.platform])
      runConfig.experiment = deepcopy(options.experiment)

      var inputFilePattern = {
        type: 'object',
        properties: {
          'expand': {
            type: 'string',
            pattern: '^\/experiment\/input-file.*'
          }
        },
        required: ['expand']
      }

      var outputFilePattern = {
        type: 'object',
        properties: {
          'config': {
            type: 'string',
            pattern: '^\/experiment\/output-file$'
          }
        },
        required: ['config']
      }

      if (exports.hasObjectPattern(runConfig, inputFilePattern)) {
        runConfig.experiment['input-file'] = [{'expand': '/experiment/input-size'}, {'config': '/benchmark/random-seed'}]
      }

      if (exports.hasObjectPattern(runConfig, outputFilePattern)) {
        runConfig.experiment['output-file'] = pointer.has(runConfig, '/benchmark/output/output-file')
          ? { 'config': '/benchmark/output/output-file' } : { 'file': './output.csv' }
      }

      // Expand run-time arguments
      exports.expand(runConfig)

      var hash = crypto.createHash('sha1')
      hash.update(JSON.stringify(runConfig))
      runConfig.type = 'run'
      runConfig['short-name'] = hash.digest('hex')

      runConfigs.push(runConfig)
    })
  })
  return runConfigs
}

exports.createRunCommand = function (config, name) {
  var options = config.implementation[name].map(function (o) {
    return '        ' + ((typeof o === 'object') ? '<unresolved ' + JSON.stringify(o) + ' >' : o)
  })

  return '    ' +
  path.join(config.environment.location, 'run') + '\\\n' +
  '        ' + path.join(config.location, config.compiler['runner-name']) + '\\\n' +
  options.join('\\\n')
}

exports.executeRun = function (config, options) {
  var runOutputSchemaPath = '/definitions/run'
  var validRunOutput = exports.createMatcher(runOutputSchemaPath)
  var checkOutput = !options['skip-output-verification'] && pointer.has(config, '/benchmark/output/output-check-arguments')
  var environmentRunPath = path.join(config.environment.location, 'run')
  var runnerPath = path.join(config.location, config.compiler['runner-name'])
  var runnerArguments = checkOutput && config.implementation.hasOwnProperty('runner-arguments-with-output-check')
    ? config.implementation['runner-arguments-with-output-check'].join(' ')
    : config.implementation['runner-arguments'].join(' ')
  var cmd = environmentRunPath + ' ' + runnerPath + ' ' + runnerArguments
  var status = shelljs.exec(cmd, {silent: !options.verbose})
  if (status.code !== 0) {
    console.log("Execution error for '" + cmd + "':")
    console.log(status.output)
    process.exit(1)
  }

  var jsonOutputMatch = status.output.match(/\{.*\}/)
  var jsonOutput
  if (jsonOutputMatch === null) {
    console.log('Invalid output for ' + runnerPath + ' with ' + runnerArguments + ',')
    console.log('missing json result:')
    console.log(status.output)
    process.exit(1)
  }

  try {
    jsonOutput = JSON.parse(jsonOutputMatch)
  } catch (e) {
    console.log('Invalid output for ' + runnerPath + ' with ' + runnerArguments + ',')
    console.log('improperly formatted json result:')
    console.log(status.output)
    process.exit(1)
  }

  if (!validRunOutput(jsonOutput)) {
    console.log('Invalid output for ' + runnerPath + ' with ' + runnerArguments + ',')
    console.log('json object does not conform to ' + runOutputSchemaPath + ' schema:')
    console.log(status.output)
    process.exit(1)
  }

  if (checkOutput) {
    if (options.verbose) {
      process.stdout.write('Verifying output: ')
    }

    if (config.benchmark.output.type === 'output-value') {
      config.experiment['output-value'] = JSON.stringify(jsonOutput.output)
      exports.expand(config, {strict: true})
    }

    cmd = pointer.get(config, '/benchmark/location') + '/output/check ' +
      pointer.get(config, '/benchmark/output/output-check-arguments').join(' ')
    status = shelljs.exec(cmd, {silent: !options.verbose})
    if (status.code !== 0) {
      console.log("error for '" + cmd + "':")
      console.log(status.output)
      process.exit(1)
    }
    if (options.verbose) {
      process.stdout.write('valid\n')
    }
  }

  return jsonOutput
}

exports.findRootDirectoryPath = function (start, name) {
  var dir = start
  var done = false
  while (!done) {
    var rootPath = path.join(dir, './' + name)
    var exists = false
    try {
      exists = fs.statSync(rootPath).isDirectory()
    } catch (e) {
      exists = false
    }

    if (exists) {
      return dir
    } else {
      done = dir === '/'
      dir = path.dirname(dir)
    }
  }

  var setupPath = path.join(dir, '.wu', 'setup.json')
  if (fs.statSync(setupPath).isFile()) {
    try {
      var setup = JSON.parse(fs.readFileSync(setupPath))

      if (!setup.hasOwnProperty('platform')) {
        console.log("'.wu/setup.json': missing 'platform' property")
        process.exit(1)
      }
    } catch (e) {
      console.log("'.wu/setup.json' is incorrectly formatted: please format it following the JSON standard")
      process.exit(1)
    }
  } else {
    console.log("'.wu/setup.json' not found: create a setup.json file in the .wu directory with the current platform")
    process.exit(1)
  }

  return null
}

exports.retrieveBuildsFromNames = function (config, buildNames) {
  function printBuildSummary (shortName) {
    var b = config.builds[shortName]
    console.log(
      '    ' + b['short-name'] + ':\n' +
      '        benchmark:      ' + b.benchmark['short-name'] +
      '        implementation: ' + b.implementation['short-name'] +
      '        compiler:       ' + b.compiler['short-name'] +
      '        build time:     ' + b.time)
  }

  function mostRecentBuilds (b0, b1) {
    var m0 = moment(config.builds[b0].time)
    var m1 = moment(config.builds[b1].time)
    if (m0.isSame(m1)) {
      return 0
    } else {
      return m0.isBefore(m1) ? 1 : -1
    }
  }

  return buildNames.map(function (b) {
    var m = b.match(/(.*builds\/)?([a-zA-Z0-9]+).*/)
    if (m === null) {
      console.log('Invalid build path ' + b)
      process.exit(1)
    }
    var p = m[2]
    var matches = Object.keys(config.builds).filter(function (b) {
      return b.match(RegExp('^' + p))
    })

    if (matches.length === 0) {
      console.log("No build with prefix '" + p + "', latest builds:")
      Object.keys(config.builds).sort(mostRecentBuilds).slice(0, 3).forEach(printBuildSummary)
      process.exit(1)
    }

    if (matches.length > 1) {
      console.log("Multiple builds with prefix '" + p + "':")
      matches.sort(mostRecentBuilds).forEach(printBuildSummary)
      process.exit(1)
    }

    return matches[0]
  }).map(function (name) {
    return pointer.get(config, '/builds/' + name)
  }).map(deepcopy)
}
