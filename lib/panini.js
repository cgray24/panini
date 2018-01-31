'use strict';

const fs = require('fs');
const path = require('path');
const EventEmitter = require('events').EventEmitter;
const assign = require('lodash.assign');
const vfs = require('vinyl-fs');
const globWatcher = require('glob-watcher');
const ora = require('ora');
const templateHelpers = require('template-helpers');
const pathPrefix = require('path-prefix');
const tryRequire = require('try-require');
const deepmerge = require('deepmerge');
const folderToObject = require('folder-to-object');
const load = require('load-whatever');
const pify = require('pify');
const glob = pify(require('glob'));
const Bistro = require('bistro'); // eslint-disable-line import/no-extraneous-dependencies
const translateHelper = require('./translate');
const render = require('./render');
const repeat = require('./repeat');
const currentPage = require('./current-page');
const configError = require('./config-error');
const folders = require('./folders');

const readFile = pify(fs.readFile);

/**
 * Core Panini class. Stores plugin options, page layouts, and external data. Also manages the loading of pages,
 * and passing them through to a rendering engine.
 */
module.exports = class Panini extends EventEmitter {
  /**
   * Initializes an instance of Panini.
   * @class
   * @param {Object} options - Configuration options to use.
   */
  constructor(options) {
    super();

    this.options = assign({
      pageLayouts: {},
      engine: 'handlebars',
      transform: {},
      builtins: true,
      quiet: false,
      defaultLocale: null
    }, options);
    this.ready = false;

    // The input folder must be supplied
    if (!this.options.input) {
      delete options.input;
      configError('An input folder must be set.', options);
      return;
    }

    // Figure out of the engine is valid, then initialize it
    const Engine = tryRequire(path.join(__dirname, `../engines/${this.options.engine}`));

    if (!Engine) {
      configError(`There's no engine named "${this.options.engine}". Use "handlebars", "pug", or "ejs" instead.`, options);
      return;
    }

    try {
      require.resolve(Engine.requires);
    } catch (err) {
      configError(`You need to install the "${Engine.requires}" package to continue.`, options);
      return;
    }

    this.engine = new Engine(this.options);

    // Set up CLI logger
    if (!this.options.quiet) {
      this.setupSpinner();
    }

    this.initialized = true;
  }

  /**
   * Set up the task runner that will process site assets (layouts, partials, etc.) and pass them to
   * the rendering engine.
   */
  setup(dest) {
    const dataExtensions = '**/*.{js,json,yml,yaml,cson}';

    this.ready = false;
    this.emit('setup_start');
    this.engine.data = {};
    this.engine.collections = {};
    this.engine.collectionPages = {};

    const stream = vfs.src(path.join(
      this.options.input,
      folders.pages,
      '**/*.*'
    ))
      .on('error', err => this.emit('error', err))
      .pipe(this.engine.getCollectionStream(this.onReady()))
      .pipe(render.call(this));

    if (dest) {
      stream.pipe(vfs.dest(dest));
    }

    const tasks = Object.assign({
      pages: {
        pattern: `${folders.data}/**/*.{${this.constructor.extensions.join(',')}}`,
        update() {
          this.compile();
        },
        remove() {
          this.compile();
        },
        thisArg: this
      },
      data: {
        pattern: folders.data + dataExtensions,
        update(name, filePath) {
          return load(filePath).then(contents => {
            this.data[name] = contents;
          });
        },
        remove(name) {
          delete this.data[name];
        },
        thisArg: this,
        run: ['pages']
      },
      locales: {
        pattern: folders.locales + dataExtensions,
        update() {
          return getLocaleData();
        },
        remove() {
          return getLocaleData();
        },
        thisArg: this,
        run: ['pages']
      },
      collections: {
        pattern: '!*',
        update() {
          return this.engine.buildCollections();
        },
        run: ['pages']
      },
      collectionData: {
        pattern: folders.collections + '/*',
        update(filePath) {
          return getCollectionData(filePath);
        },
        remove(filePath) {
          return getCollectionData(filePath);
        },
        run: ['collections']
      }
    }, this.constructor.tasks);

    this.runner = new Bistro(tasks, {
      baseDir: this.options.input
    });

    this.runner.start().then(() => {
      this.ready = true;
      this.emit('setup_done');
    });

    function getLocaleData() {
      return folderToObject(path.join(this.options.input, folders.locales)).then(res => {
        this.engine.locales = Object.keys(res);
        this.engine.localeData = res;
      });
    }

    function getCollectionData(filePath) {
      const module = tryRequire(filePath);

      if (!module) {
        return;
      }

      const name = path.basename(filePath);
      const templatePath = path.join(filePath, 'template.*');

      return glob(templatePath).then(res => readFile(res[0])).then(res => {
        this.engine.collections[name] = assign({}, module, {template: res});
      });
    }
  }

  /**
   * Returns a Promise that resolves if, or when, Panini is done setting up its internal cache.
   * @returns {Promise} Promise which resolves when the internal cache has been updated.
   */
  onReady() {
    return new Promise(resolve => {
      if (this.ready) {
        // Resolve right away if Panini is not mid-refresh
        resolve();
      } else {
        // Otherwise, wait for the refresh to be done
        this.once('setup_done', resolve);
      }
    });
  }

  /**
   * Watch for changes to layouts, partials, helpers, and data, and reload Panini's internal cache when files are added, removed, or changed.
   */
  setupWatchers() {
    const features = this.engine.constructor.features.concat(['data']);
    const paths = features.map(i =>
      path.join(this.options.input, this.options[i], '**/*.*')
    );

    globWatcher(paths, () => {
      return this.refresh();
    });
  }

  /*
   * Creates a CLI spinner which gives the user status updates as Panini works. The Panini class instance will fire the events listened to in this function at various points in the building process.
   */
  setupSpinner() {
    this.spinner = ora('Setting the table...');

    // Fires when the internal cache is being refreshed
    this.on('refreshing', () => {
      this.spinner.start();
    });

    // Fires when pages are being parsed and converted to data
    this.on('parsing', () => {
      this.spinner.text = 'Parsing pages...';
    });

    // Fires when pages are being built into HTML files
    this.on('building', () => {
      this.spinner.text = 'Building pages...';
    });

    // Fires when all pages have been built and written to disk
    this.on('built', (pageCount, errorCount) => {
      const plural = pageCount < 1 || pageCount > 1;
      const method = errorCount ? 'succeed' : 'succeed';
      const errorText = errorCount ?
        `, but ${errorCount} had errors.` :
        '.';
      this.spinner[method](`${pageCount} page${plural ? 's' : ''} built${errorText}`);
    });

    // Fires when there's an error unrelated to a page's template being rendered
    // Those errors are written to the pages themselves instead of being written to the console
    this.on('error', err => {
      this.spinner.fail('There was an error while parsing pages.');
      console.log(err);
    });
  }

  /**
   * Assemble the template data for a page. Page data is prioritized in the following order, from
   * lowest to highest:
   *   - Loaded data files
   *   - Vinyl file attributes
   *   - Page Front Matter
   *   - Page constants:
   *     - `page`: basename of the page
   *     - `layout`: dervied layout of the page
   *     - `root`: path prefix to root directory from this page
   *   - Helper functions
   *
   * @param {Object} file - Vinyl file containing the page.
   * @param {Object} [attributes] - Page Front Matter.
   * @param {Object} [error] - Page parsing error.
   * @returns {Object} Page template data.
   */
  getPageData(file, attributes, error) {
    // Determine which layout to use
    let layout;
    if (this.engine.supports('layouts')) {
      const basePath = path.relative(
        path.join(this.options.input, folders.pages),
        path.dirname(file.path)
      );
      layout =
        attributes.layout ||
        this.options.pageLayouts[basePath] ||
        'default';
    }

    const constants = {
      // Basename of file
      page: path.basename(file.path, path.extname(file.path)),
      // Layout used by this page
      layout,
      // Path prefix to root directory
      root: pathPrefix(file.path, path.join(this.options.input, folders.pages)),
      // Locale
      locale: file.data && file.data.paniniLocale,
      // Panini error
      _paniniError: error
    };

    let data = assign(
      {},
      // Global data
      this.engine.data,
      // Data from Gulp stream plugins
      file.data || {}
    );

    // Page Front Matter is deeply merged with global data and file attributes
    data = deepmerge(data, attributes);

    // Finally, add page constants and helper functions
    return assign(data, constants, this.getHelpers(file));
  }

  /**
   * Generate helper functions to be used by a page's template. The kinds of helpers returned varies depending on the page being rendered and the template engine being used.
   *   - Handlebars uses helpers from the handlebars-helpers library.
   *   - All other engines use the more generic template-helpers library.
   *   - A `currentPage()` helper is added, which is generated based on the current page's filename.
   *   - A `translate()` is added if localization is enabled. It outputs language strings based on the locale of the page being rendered.
   *
   * @param {Object} file - Vinyl file about to be rendered.
   * @returns {Object.<String, Function>} Series of helper functions to attach to the page being rendered.
   */
  getHelpers(file) {
    // If builtins are disabled by the developer, no helpers are added
    if (!this.options.builtins) {
      return {};
    }

    // All rendering engines get these functions
    const coreHelpers = {
      currentPage: currentPage(path.basename(file.path, path.extname(file.path)))
    };

    // If internationalization is enabled, all rendering engines also get the `translate()` function
    if (this.engine.i18n && file.data && file.data.paniniLocale) {
      coreHelpers.translate = translateHelper(this.engine.localeData, file.data.paniniLocale);
    }

    // Handlebars doesn't use template-helpers. Instead, it uses the more specific handlebars-helpers library
    // These are applied when the `HandlebarsEngine` class is initialized
    if (this.options.engine === 'handlebars') {
      return assign({repeat}, coreHelpers);
    }

    // All non-Handlebars engines use the template-helpers library
    return assign({}, coreHelpers, templateHelpers());
  }

  /**
   * Compile a Panini site. This function creates a Vinyl source stream out of every template in the `pages/` folder, and then passes the pages to a render function. If `dest` is provided, the final pages will be output to the given destination folder.
   * @param {String} [dest] - Folder to write final pages to.
   * @returns {Object} Readable stream containing final pages.
   */
  compile(dest) {
    const stream = vfs.src(path.join(
      this.options.input,
      folders.pages,
      '**/*.*'
    ))
      .on('error', err => this.emit('error', err))
      .pipe(this.engine.getCollectionStream(this.onReady()))
      .pipe(render.call(this));

    if (dest) {
      stream.pipe(vfs.dest(dest));
    }

    return stream;
  }
};
