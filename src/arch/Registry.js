'use strict'

/**
 * Dependencies
 * @ignore
 */
const _ = require('lodash')
const path = require('path')
const glob = require('glob')
const semver = require('semver')
const injector = require('./injectorInstance')
const Plugin = require('./Plugin')
const PluginCollection = require('./PluginCollection')

/**
 * Symbols
 * @ignore
 */
const plugins = Symbol()

/**
 * Registry
 *
 * @class
 * Plugins are loaded and maintained in memory by the registry. The Registry
 * class can find and load plugins from the filesystem, resolve plugin
 * dependencies, order plugins such that their dependencies are all met,
 * and initialize plugins. This process is called bootstrapping and it is the
 * beginning of the plugin lifecycle.
 *
 * A single registry instance is created by the Host constructor, which is then
 * used in a variety of ways.
 *
 * Instantiating:
 *
 * ```js
 * let registry = new Registry({ ... })
 * ```
 *
 * Storing and querying plugins:
 *
 * ```js
 * registry.set(<name>, new Plugin({ ... }))
 * registry.get(<name>)
 * registry.del(<name>)
 *
 * registry.filter({ type: '<type>' })
 * registry.filter(plugin => <boolean-expr>)
 * ```
 *
 * Bootstrapping:
 *
 * ```js
 * registry
 *   .glob()
 *   .require()
 *   .resolve()
 *   .prioritize()
 *   .initialize()
 * ```
 *
 * Plugin registration:
 *
 * ```js
 * module.exports = function (<registry>) {
 *   <registry>.plugin(<name>, <metadata>).initializer(<callback>)
 * }
 * ```
 *
 * This module requires {@link Plugin} and {@link PluginCollection}.
 */
class Registry {

  /**
   * constructor
   *
   * @description Initialize a Registry instance.
   * @param {Object} options - Options object
   */
  constructor (options) {
    this[plugins] = {}
    this.prioritized = new PluginCollection()
    this.directories = _.uniq(options.directories || [
      path.join(process.cwd(), 'plugins')
    ])
  }

  /**
   * get
   *
   * @description Retrieve a plugin from the registry.
   * @param {string} name - name of the plugin
   * @returns {Plugin}
   */
  get (name) {
    return this[plugins][name]
  }

  /**
   * set
   *
   * @description Set a plugin on the registry.
   * @param {string} name - Name of the plugin
   * @param {Plugin} plugin - Name of the plugin
   * @returns {Plugin}
   */
  set (name, plugin) {
    if (!(plugin instanceof Plugin)) {
      let json = JSON.stringify(plugin)
      throw new Error(`${json} is not a Plugin instance.`)
    }

    this[plugins][name] = plugin
    return plugin
  }

  /**
   * del
   *
   * @description Remove a plugin from the registry.
   * @param {string} name - Name of the plugin
   * @returns {Plugin}
   */
  del (name) {
    return delete this[plugins][name]
  }

  /**
   * filter
   *
   * @description Query the registry for plugins matching a predicate
   * @param {(Object|function)} predicate - Description or function for matching plugins
   * @returns {PluginCollection}
   *
   * @example <caption>Object predicate</caption>
   * registry.filter({ enabled: true })
   *
   * @example <caption>Function predicate</caption>
   * registry.filter(plugin => !!plugin.name.match(regexp))
   */
  filter (predicate) {
    return this.prioritized.filter(predicate)
  }

  /**
   * glob
   *
   * @description Search the configured directories for plugin index files.
   */
  glob () {
    this.files = this.directories.reduce((results, directory) => {
      let pattern = path.join(directory, '**/index.js')
      let files = glob.sync(path.resolve(pattern))
      return results.concat(files)
    }, [])

    return this
  }

  /**
   * require
   *
   * @description Load plugins to the registry without initializing them.
   */
  require () {
    this.files.forEach(filename => {
      require(filename)(this)
    })

    return this
  }

  /**
   * resolve
   *
   * @description
   * Resolves and validates dependencies and dependents of
   * all plugins.
   */
  resolve () {
    Object.keys(this[plugins]).forEach(key => {
      let plugin = this[plugins][key]
      let metadata = plugin.metadata
      let dependencies = metadata.dependencies || {}

      Object.keys(dependencies).forEach(name => {
        let range = dependencies[name]

        // validate presence
        let dependency = this[plugins][name]
        if (!dependency) {
          throw new Error(`Dependency ${name} missing.`)
        }

        // validate version
        let version = dependency.metadata.version
        if (!semver.satisfies(version, range)) {
          throw new Error(`${name} ${version} does not satisfy ${range}.`)
        }

        // link to dependents
        dependency.dependents = dependency.dependents || {}
        dependency.dependents[plugin.name] = plugin

        // link to dependencies
        plugin.dependencies = plugin.dependencies || {}
        plugin.dependencies[name] = dependency
      })
    })

    return this
  }

  /**
   * satisfy
   *
   * @description
   * Given a list of plugins without dependencies and a list of
   * plugins with dependencies, return a list of plugins such that
   * no plugins appear before their dependencies.
   */
  satisfy (ordered, remaining) {
    let source = [].concat(remaining)
    let target = [].concat(ordered)

    // move satisfied dependencies from remaining to prioritized
    source.forEach((plugin, index) => {
      let dependencies = _.values(plugin.dependencies)

      // check if the plugin's dependencies are satisfied
      let isSatisfied = dependencies.every(dependency => {
        return target.indexOf(dependency) !== -1
      })

      if (isSatisfied) {
        target.push(plugin)
        source.splice(index, 1)
      }
    })

    return (source.length === 0) ? target : this.satisfy(target, source)
  }

  /**
   * prioritize
   *
   * @description
   * Given a list of plugins with dependencies, sort the list such that
   * all dependencies can be met by iterating over the list.
   */
  prioritize () {
    let ordered = []
    let remaining = [].concat(_.values(this[plugins]))

    // separate the plugins that have no dependencies
    remaining.forEach((plugin, index) => {
      if (
        !plugin.dependencies ||
        Object.keys(plugin.dependencies).length === 0
      ) {
        ordered.push(plugin)
        remaining.splice(index, 1)
      }
    })

    // recurse through the remaining dependencies
    this.prioritized = new PluginCollection(this.satisfy(ordered, remaining))

    return this
  }

  /**
   * initialize
   *
   * @description
   * Iterate over prioritized plugins and invoke initializer methods.
   */
  initialize () {
    this.prioritized.forEach(plugin => {
      plugin.initialize()
    })
  }

  /**
   * plugin
   *
   * @description
   * Register or retrieve a plugin from the injector with a name and metadata object.
   *
   * @param {string} name - Plugin name
   * @param {Object} metadata - Plugin metadata
   * @returns {Plugin}
   */
  plugin (name, metadata) {
    if (metadata) {
      return this.set(name, new Plugin(name, metadata))
    } else {
      return this.get(name)
    }
  }

}

/**
 * Exports
 */
module.exports = Registry
