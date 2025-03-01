'use strict';
const path = require('path');
const del = require('del');
const updateNotifier = require('update-notifier');
const figures = require('figures');
const arrify = require('arrify');
const yargs = require('yargs');
const isCi = require('is-ci');
const readPkg = require('read-pkg');
const loadConfig = require('./load-config');

function exit(message) {
	console.error(`\n  ${require('./chalk').get().red(figures.cross)} ${message}`);
	process.exit(1); // eslint-disable-line unicorn/no-process-exit
}

const coerceLastValue = value => {
	return Array.isArray(value) ? value.pop() : value;
};

const FLAGS = {
	concurrency: {
		alias: 'c',
		coerce: coerceLastValue,
		description: 'Max number of test files running at the same time (default: CPU cores)',
		type: 'number'
	},
	'fail-fast': {
		coerce: coerceLastValue,
		description: 'Stop after first test failure',
		type: 'boolean'
	},
	match: {
		alias: 'm',
		description: 'Only run tests with matching title (can be repeated)',
		type: 'string'
	},
	'node-arguments': {
		coerce: coerceLastValue,
		description: 'Additional Node.js arguments for launching worker processes (specify as a single string)',
		type: 'string'
	},
	serial: {
		alias: 's',
		coerce: coerceLastValue,
		description: 'Run tests serially',
		type: 'boolean'
	},
	tap: {
		alias: 't',
		coerce: coerceLastValue,
		description: 'Generate TAP output',
		type: 'boolean'
	},
	timeout: {
		alias: 'T',
		coerce: coerceLastValue,
		description: 'Set global timeout (milliseconds or human-readable, e.g. 10s, 2m)',
		type: 'string'
	},
	'update-snapshots': {
		alias: 'u',
		coerce: coerceLastValue,
		description: 'Update snapshots',
		type: 'boolean'
	},
	verbose: {
		alias: 'v',
		coerce: coerceLastValue,
		description: 'Enable verbose output',
		type: 'boolean'
	},
	watch: {
		alias: 'w',
		coerce: coerceLastValue,
		description: 'Re-run tests when files change',
		type: 'boolean'
	}
};

exports.run = async () => { // eslint-disable-line complexity
	let conf = {};
	let confError = null;
	try {
		const {argv: {config: configFile}} = yargs.help(false);
		conf = loadConfig({configFile});
	} catch (error) {
		confError = error;
	}

	let debug = null;
	let resetCache = false;
	const {argv} = yargs
		.parserConfiguration({
			'boolean-negation': true,
			'camel-case-expansion': false,
			'combine-arrays': false,
			'dot-notation': false,
			'duplicate-arguments-array': true,
			'flatten-duplicate-arrays': true,
			'negation-prefix': 'no-',
			'parse-numbers': true,
			'populate--': true,
			'set-placeholder-key': false,
			'short-option-groups': true,
			'strip-aliased': true,
			'unknown-options-as-args': false
		})
		.usage('$0 [<pattern>...]')
		.usage('$0 debug [<pattern>...]')
		.usage('$0 reset-cache')
		.options({
			color: {
				description: 'Force color output',
				type: 'boolean'
			},
			config: {
				description: 'Specific JavaScript file for AVA to read its config from, instead of using package.json or ava.config.* files'
			}
		})
		.command('* [<pattern>...]', 'Run tests', yargs => yargs.options(FLAGS).positional('pattern', {
			array: true,
			describe: 'Glob patterns to select what test files to run. Leave empty if you want AVA to run all test files instead',
			type: 'string'
		}))
		.command(
			'debug [<pattern>...]',
			'Activate Node.js inspector and run a single test file',
			yargs => yargs.options(FLAGS).options({
				break: {
					description: 'Break before the test file is loaded',
					type: 'boolean'
				},
				port: {
					default: 9229,
					description: 'Port on which you can connect to the inspector',
					type: 'number'
				}
			}).positional('pattern', {
				demand: true,
				describe: 'Glob patterns to select a single test file to debug',
				type: 'string'
			}),
			argv => {
				debug = {
					break: argv.break === true,
					files: argv.pattern,
					port: argv.port
				};
			})
		.command(
			'reset-cache',
			'Reset AVA\'s compilation cache and exit',
			yargs => yargs,
			() => {
				resetCache = true;
			})
		.example('$0')
		.example('$0 test.js')
		.help();

	const combined = {...conf};
	for (const flag of Object.keys(FLAGS)) {
		if (Reflect.has(argv, flag)) {
			if (flag === 'fail-fast') {
				combined.failFast = argv[flag];
			} else if (flag === 'update-snapshots') {
				combined.updateSnapshots = argv[flag];
			} else if (flag !== 'node-arguments') {
				combined[flag] = argv[flag];
			}
		}
	}

	const chalkOptions = {level: combined.color === false ? 0 : require('chalk').level};
	const chalk = require('./chalk').set(chalkOptions);

	if (confError) {
		if (confError.parent) {
			exit(`${confError.message}\n\n${chalk.gray((confError.parent && confError.parent.stack) || confError.parent)}`);
		} else {
			exit(confError.message);
		}
	}

	updateNotifier({pkg: require('../package.json')}).notify();

	const {nonSemVerExperiments: experiments, projectDir} = conf;
	if (resetCache) {
		const cacheDir = path.join(projectDir, 'node_modules', '.cache', 'ava');
		try {
			await del('*', {
				cwd: cacheDir,
				nodir: true
			});
			console.error(`\n${chalk.green(figures.tick)} Removed AVA cache files in ${cacheDir}`);
			process.exit(0); // eslint-disable-line unicorn/no-process-exit
		} catch (error) {
			exit(`Error removing AVA cache files in ${cacheDir}\n\n${chalk.gray((error && error.stack) || error)}`);
		}

		return;
	}

	if (argv.watch) {
		if (argv.tap && !conf.tap) {
			exit('The TAP reporter is not available when using watch mode.');
		}

		if (isCi) {
			exit('Watch mode is not available in CI, as it prevents AVA from terminating.');
		}

		if (debug !== null) {
			exit('Watch mode is not available when debugging.');
		}
	}

	if (debug !== null) {
		if (argv.tap && !conf.tap) {
			exit('The TAP reporter is not available when debugging.');
		}

		if (isCi) {
			exit('Debugging is not available in CI.');
		}

		if (combined.timeout) {
			console.log(chalk.magenta(`  ${figures.warning} The timeout option has been disabled to help with debugging.`));
		}
	}

	if (Reflect.has(combined, 'concurrency') && (!Number.isInteger(combined.concurrency) || combined.concurrency < 0)) {
		exit('The --concurrency or -c flag must be provided with a nonnegative integer.');
	}

	if (!combined.tap && Object.keys(experiments).length > 0) {
		console.log(chalk.magenta(`  ${figures.warning} Experiments are enabled. These are unsupported and may change or be removed at any time.`));
	}

	if (Reflect.has(conf, 'compileEnhancements')) {
		exit('Enhancement compilation must be configured in AVA’s Babel options.');
	}

	if (Reflect.has(conf, 'helpers')) {
		exit('AVA no longer compiles helpers. Add exclusion patterns to the \'files\' configuration and specify \'compileAsTests\' in the Babel options instead.');
	}

	if (Reflect.has(conf, 'sources')) {
		exit('\'sources\' has been removed. Use \'ignoredByWatcher\' to provide glob patterns of files that the watcher should ignore.');
	}

	const ciParallelVars = require('ci-parallel-vars');
	const Api = require('./api');
	const VerboseReporter = require('./reporters/verbose');
	const MiniReporter = require('./reporters/mini');
	const TapReporter = require('./reporters/tap');
	const Watcher = require('./watcher');
	const normalizeExtensions = require('./extensions');
	const {normalizeGlobs, normalizePatterns} = require('./globs');
	const normalizeNodeArguments = require('./node-arguments');
	const validateEnvironmentVariables = require('./environment-variables');
	const providerManager = require('./provider-manager');

	let pkg;
	try {
		pkg = readPkg.sync({cwd: projectDir});
	} catch (error) {
		if (error.code !== 'ENOENT') {
			throw error;
		}
	}

	const {type: defaultModuleType = 'commonjs'} = pkg || {};

	const moduleTypes = {
		cjs: 'commonjs',
		mjs: 'module',
		js: defaultModuleType
	};

	const providers = [];
	if (Reflect.has(conf, 'babel')) {
		try {
			const {level, main} = providerManager.babel(projectDir);
			providers.push({
				level,
				main: main({config: conf.babel}),
				type: 'babel'
			});
		} catch (error) {
			exit(error.message);
		}
	}

	if (Reflect.has(conf, 'typescript')) {
		try {
			const {level, main} = providerManager.typescript(projectDir);
			providers.push({
				level,
				main: main({config: conf.typescript}),
				type: 'typescript'
			});
		} catch (error) {
			exit(error.message);
		}
	}

	let environmentVariables;
	try {
		environmentVariables = validateEnvironmentVariables(conf.environmentVariables);
	} catch (error) {
		exit(error.message);
	}

	let extensions;
	try {
		extensions = normalizeExtensions(conf.extensions, providers);
	} catch (error) {
		exit(error.message);
	}

	let globs;
	try {
		globs = normalizeGlobs({files: conf.files, ignoredByWatcher: conf.ignoredByWatcher, extensions, providers});
	} catch (error) {
		exit(error.message);
	}

	let nodeArguments;
	try {
		nodeArguments = normalizeNodeArguments(conf.nodeArguments, argv['node-arguments']);
	} catch (error) {
		exit(error.message);
	}

	let parallelRuns = null;
	if (isCi && ciParallelVars) {
		const {index: currentIndex, total: totalRuns} = ciParallelVars;
		parallelRuns = {currentIndex, totalRuns};
	}

	const match = combined.match === '' ? [] : arrify(combined.match);

	const input = debug ? debug.files : (argv.pattern || []);
	const filter = normalizePatterns(input.map(fileOrPattern => path.relative(projectDir, path.resolve(process.cwd(), fileOrPattern))));

	const api = new Api({
		cacheEnabled: combined.cache !== false,
		chalkOptions,
		concurrency: combined.concurrency || 0,
		debug,
		environmentVariables,
		experiments,
		extensions,
		failFast: combined.failFast,
		failWithoutAssertions: combined.failWithoutAssertions !== false,
		globs,
		match,
		moduleTypes,
		nodeArguments,
		parallelRuns,
		projectDir,
		providers,
		ranFromCli: true,
		require: arrify(combined.require),
		serial: combined.serial,
		snapshotDir: combined.snapshotDir ? path.resolve(projectDir, combined.snapshotDir) : null,
		timeout: combined.timeout || '10s',
		updateSnapshots: combined.updateSnapshots,
		workerArgv: argv['--']
	});

	let reporter;
	if (combined.tap && !combined.watch && debug === null) {
		reporter = new TapReporter({
			projectDir,
			reportStream: process.stdout,
			stdStream: process.stderr
		});
	} else if (debug !== null || combined.verbose || isCi || !process.stdout.isTTY) {
		reporter = new VerboseReporter({
			projectDir,
			reportStream: process.stdout,
			stdStream: process.stderr,
			watching: combined.watch
		});
	} else {
		reporter = new MiniReporter({
			projectDir,
			reportStream: process.stdout,
			stdStream: process.stderr,
			watching: combined.watch
		});
	}

	api.on('run', plan => {
		reporter.startRun(plan);

		plan.status.on('stateChange', evt => {
			if (evt.type === 'interrupt') {
				reporter.endRun();
				process.exit(1); // eslint-disable-line unicorn/no-process-exit
			}
		});
	});

	if (combined.watch) {
		const watcher = new Watcher({
			api,
			filter,
			globs,
			projectDir,
			providers,
			reporter
		});
		watcher.observeStdin(process.stdin);
	} else {
		let debugWithoutSpecificFile = false;
		api.on('run', plan => {
			if (plan.debug && plan.files.length !== 1) {
				debugWithoutSpecificFile = true;
			}
		});

		const runStatus = await api.run({filter});

		if (debugWithoutSpecificFile) {
			exit('Provide the path to the test file you wish to debug');
			return;
		}

		process.exitCode = runStatus.suggestExitCode({matching: match.length > 0});
		reporter.endRun();
	}
};
