/**
 * @license
 * Copyright Google Inc. All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import {GeneratedFile} from '@angular/compiler';
import * as ts from 'typescript';

import * as api from '../transformers/api';
import {nocollapseHack} from '../transformers/nocollapse_hack';

import {ComponentDecoratorHandler, DirectiveDecoratorHandler, InjectableDecoratorHandler, NgModuleDecoratorHandler, NoopReferencesRegistry, PipeDecoratorHandler, ReferencesRegistry, ResourceLoader, SelectorScopeRegistry} from './annotations';
import {BaseDefDecoratorHandler} from './annotations/src/base_def';
import {ErrorCode, ngErrorCode} from './diagnostics';
import {FlatIndexGenerator, ReferenceGraph, checkForPrivateExports, findFlatIndexEntryPoint} from './entry_point';
import {Reference} from './imports';
import {PartialEvaluator} from './partial_evaluator';
import {TypeScriptReflectionHost} from './reflection';
import {FileResourceLoader, HostResourceLoader} from './resource_loader';
import {FactoryGenerator, FactoryInfo, GeneratedShimsHostWrapper, ShimGenerator, SummaryGenerator, generatedFactoryTransform} from './shims';
import {ivySwitchTransform} from './switch';
import {IvyCompilation, ivyTransformFactory} from './transform';
import {TypeCheckContext, TypeCheckProgramHost} from './typecheck';
import {isDtsPath} from './util/src/typescript';

export class NgtscProgram implements api.Program {
  private tsProgram: ts.Program;
  private resourceLoader: ResourceLoader;
  private compilation: IvyCompilation|undefined = undefined;
  private factoryToSourceInfo: Map<string, FactoryInfo>|null = null;
  private sourceToFactorySymbols: Map<string, Set<string>>|null = null;
  private host: ts.CompilerHost;
  private _coreImportsFrom: ts.SourceFile|null|undefined = undefined;
  private _reflector: TypeScriptReflectionHost|undefined = undefined;
  private _isCore: boolean|undefined = undefined;
  private rootDirs: string[];
  private closureCompilerEnabled: boolean;
  private entryPoint: ts.SourceFile|null;
  private exportReferenceGraph: ReferenceGraph|null = null;
  private flatIndexGenerator: FlatIndexGenerator|null = null;

  private constructionDiagnostics: ts.Diagnostic[] = [];


  constructor(
      rootNames: ReadonlyArray<string>, private options: api.CompilerOptions,
      host: api.CompilerHost, oldProgram?: api.Program) {
    this.rootDirs = [];
    if (options.rootDirs !== undefined) {
      this.rootDirs.push(...options.rootDirs);
    } else if (options.rootDir !== undefined) {
      this.rootDirs.push(options.rootDir);
    } else {
      this.rootDirs.push(host.getCurrentDirectory());
    }
    this.closureCompilerEnabled = !!options.annotateForClosureCompiler;
    this.resourceLoader =
        host.readResource !== undefined && host.resourceNameToFileName !== undefined ?
        new HostResourceLoader(
            host.resourceNameToFileName.bind(host), host.readResource.bind(host)) :
        new FileResourceLoader(host, this.options);
    const shouldGenerateShims = options.allowEmptyCodegenFiles || false;
    this.host = host;
    let rootFiles = [...rootNames];

    const generators: ShimGenerator[] = [];
    if (shouldGenerateShims) {
      // Summary generation.
      const summaryGenerator = SummaryGenerator.forRootFiles(rootNames);

      // Factory generation.
      const factoryGenerator = FactoryGenerator.forRootFiles(rootNames);
      const factoryFileMap = factoryGenerator.factoryFileMap;
      this.factoryToSourceInfo = new Map<string, FactoryInfo>();
      this.sourceToFactorySymbols = new Map<string, Set<string>>();
      factoryFileMap.forEach((sourceFilePath, factoryPath) => {
        const moduleSymbolNames = new Set<string>();
        this.sourceToFactorySymbols !.set(sourceFilePath, moduleSymbolNames);
        this.factoryToSourceInfo !.set(factoryPath, {sourceFilePath, moduleSymbolNames});
      });

      const factoryFileNames = Array.from(factoryFileMap.keys());
      rootFiles.push(...factoryFileNames, ...summaryGenerator.getSummaryFileNames());
      generators.push(summaryGenerator, factoryGenerator);
    }

    let entryPoint: string|null = null;
    if (options.flatModuleOutFile !== undefined) {
      entryPoint = findFlatIndexEntryPoint(rootNames);
      if (entryPoint === null) {
        // This error message talks specifically about having a single .ts file in "files". However
        // the actual logic is a bit more permissive. If a single file exists, that will be taken,
        // otherwise the highest level (shortest path) "index.ts" file will be used as the flat
        // module entry point instead. If neither of these conditions apply, the error below is
        // given.
        //
        // The user is not informed about the "index.ts" option as this behavior is deprecated -
        // an explicit entrypoint should always be specified.
        this.constructionDiagnostics.push({
          category: ts.DiagnosticCategory.Error,
          code: ngErrorCode(ErrorCode.CONFIG_FLAT_MODULE_NO_INDEX),
          file: undefined,
          start: undefined,
          length: undefined,
          messageText:
              'Angular compiler option "flatModuleOutFile" requires one and only one .ts file in the "files" field.',
        });
      } else {
        const flatModuleId = options.flatModuleId || null;
        this.flatIndexGenerator =
            new FlatIndexGenerator(entryPoint, options.flatModuleOutFile, flatModuleId);
        generators.push(this.flatIndexGenerator);
        rootFiles.push(this.flatIndexGenerator.flatIndexPath);
      }
    }

    if (generators.length > 0) {
      this.host = new GeneratedShimsHostWrapper(host, generators);
    }

    this.tsProgram =
        ts.createProgram(rootFiles, options, this.host, oldProgram && oldProgram.getTsProgram());

    this.entryPoint = entryPoint !== null ? this.tsProgram.getSourceFile(entryPoint) || null : null;
  }

  getTsProgram(): ts.Program { return this.tsProgram; }

  getTsOptionDiagnostics(cancellationToken?: ts.CancellationToken|
                         undefined): ReadonlyArray<ts.Diagnostic> {
    return this.tsProgram.getOptionsDiagnostics(cancellationToken);
  }

  getNgOptionDiagnostics(cancellationToken?: ts.CancellationToken|
                         undefined): ReadonlyArray<ts.Diagnostic|api.Diagnostic> {
    return this.constructionDiagnostics;
  }

  getTsSyntacticDiagnostics(
      sourceFile?: ts.SourceFile|undefined,
      cancellationToken?: ts.CancellationToken|undefined): ReadonlyArray<ts.Diagnostic> {
    return this.tsProgram.getSyntacticDiagnostics(sourceFile, cancellationToken);
  }

  getNgStructuralDiagnostics(cancellationToken?: ts.CancellationToken|
                             undefined): ReadonlyArray<api.Diagnostic> {
    return [];
  }

  getTsSemanticDiagnostics(
      sourceFile?: ts.SourceFile|undefined,
      cancellationToken?: ts.CancellationToken|undefined): ReadonlyArray<ts.Diagnostic> {
    return this.tsProgram.getSemanticDiagnostics(sourceFile, cancellationToken);
  }

  getNgSemanticDiagnostics(
      fileName?: string|undefined, cancellationToken?: ts.CancellationToken|
                                   undefined): ReadonlyArray<ts.Diagnostic|api.Diagnostic> {
    const compilation = this.ensureAnalyzed();
    const diagnostics = [...compilation.diagnostics];
    if (!!this.options.fullTemplateTypeCheck) {
      const ctx = new TypeCheckContext();
      compilation.typeCheck(ctx);
      diagnostics.push(...this.compileTypeCheckProgram(ctx));
    }
    if (this.entryPoint !== null && this.exportReferenceGraph !== null) {
      diagnostics.push(...checkForPrivateExports(
          this.entryPoint, this.tsProgram.getTypeChecker(), this.exportReferenceGraph));
    }
    return diagnostics;
  }

  async loadNgStructureAsync(): Promise<void> {
    if (this.compilation === undefined) {
      this.compilation = this.makeCompilation();
    }
    await Promise.all(this.tsProgram.getSourceFiles()
                          .filter(file => !file.fileName.endsWith('.d.ts'))
                          .map(file => this.compilation !.analyzeAsync(file))
                          .filter((result): result is Promise<void> => result !== undefined));
  }

  listLazyRoutes(entryRoute?: string|undefined): api.LazyRoute[] { return []; }

  getLibrarySummaries(): Map<string, api.LibrarySummary> {
    throw new Error('Method not implemented.');
  }

  getEmittedGeneratedFiles(): Map<string, GeneratedFile> {
    throw new Error('Method not implemented.');
  }

  getEmittedSourceFiles(): Map<string, ts.SourceFile> {
    throw new Error('Method not implemented.');
  }

  private ensureAnalyzed(): IvyCompilation {
    if (this.compilation === undefined) {
      this.compilation = this.makeCompilation();
      this.tsProgram.getSourceFiles()
          .filter(file => !file.fileName.endsWith('.d.ts'))
          .forEach(file => this.compilation !.analyzeSync(file));
    }
    return this.compilation;
  }

  emit(opts?: {
    emitFlags?: api.EmitFlags,
    cancellationToken?: ts.CancellationToken,
    customTransformers?: api.CustomTransformers,
    emitCallback?: api.TsEmitCallback,
    mergeEmitResultsCallback?: api.TsMergeEmitResultsCallback
  }): ts.EmitResult {
    const emitCallback = opts && opts.emitCallback || defaultEmitCallback;

    this.ensureAnalyzed();

    // Since there is no .d.ts transformation API, .d.ts files are transformed during write.
    const writeFile: ts.WriteFileCallback =
        (fileName: string, data: string, writeByteOrderMark: boolean,
         onError: ((message: string) => void) | undefined,
         sourceFiles: ReadonlyArray<ts.SourceFile>) => {
          if (fileName.endsWith('.d.ts')) {
            data = sourceFiles.reduce(
                (data, sf) => this.compilation !.transformedDtsFor(sf.fileName, data), data);
          } else if (this.closureCompilerEnabled && fileName.endsWith('.ts')) {
            data = nocollapseHack(data);
          }
          this.host.writeFile(fileName, data, writeByteOrderMark, onError, sourceFiles);
        };

    const customTransforms = opts && opts.customTransformers;
    const beforeTransforms =
        [ivyTransformFactory(this.compilation !, this.reflector, this.coreImportsFrom)];

    if (this.factoryToSourceInfo !== null) {
      beforeTransforms.push(
          generatedFactoryTransform(this.factoryToSourceInfo, this.coreImportsFrom));
    }
    if (this.isCore) {
      beforeTransforms.push(ivySwitchTransform);
    }
    if (customTransforms && customTransforms.beforeTs) {
      beforeTransforms.push(...customTransforms.beforeTs);
    }

    // Run the emit, including a custom transformer that will downlevel the Ivy decorators in code.
    const emitResult = emitCallback({
      program: this.tsProgram,
      host: this.host,
      options: this.options,
      emitOnlyDtsFiles: false, writeFile,
      customTransformers: {
        before: beforeTransforms,
        after: customTransforms && customTransforms.afterTs,
      },
    });
    return emitResult;
  }

  private compileTypeCheckProgram(ctx: TypeCheckContext): ReadonlyArray<ts.Diagnostic> {
    const host = new TypeCheckProgramHost(this.tsProgram, this.host, ctx);
    const auxProgram = ts.createProgram({
      host,
      rootNames: this.tsProgram.getRootFileNames(),
      oldProgram: this.tsProgram,
      options: this.options,
    });
    return auxProgram.getSemanticDiagnostics();
  }

  private makeCompilation(): IvyCompilation {
    const checker = this.tsProgram.getTypeChecker();
    const evaluator = new PartialEvaluator(this.reflector, checker);
    const scopeRegistry = new SelectorScopeRegistry(checker, this.reflector);

    // If a flat module entrypoint was specified, then track references via a `ReferenceGraph` in
    // order to produce proper diagnostics for incorrectly exported directives/pipes/etc. If there
    // is no flat module entrypoint then don't pay the cost of tracking references.
    let referencesRegistry: ReferencesRegistry;
    if (this.entryPoint !== null) {
      this.exportReferenceGraph = new ReferenceGraph();
      referencesRegistry = new ReferenceGraphAdapter(this.exportReferenceGraph);
    } else {
      referencesRegistry = new NoopReferencesRegistry();
    }

    // Set up the IvyCompilation, which manages state for the Ivy transformer.
    const handlers = [
      new BaseDefDecoratorHandler(this.reflector, evaluator),
      new ComponentDecoratorHandler(
          this.reflector, evaluator, scopeRegistry, this.isCore, this.resourceLoader, this.rootDirs,
          this.options.preserveWhitespaces || false, this.options.i18nUseExternalIds !== false),
      new DirectiveDecoratorHandler(this.reflector, evaluator, scopeRegistry, this.isCore),
      new InjectableDecoratorHandler(this.reflector, this.isCore),
      new NgModuleDecoratorHandler(
          this.reflector, evaluator, scopeRegistry, referencesRegistry, this.isCore),
      new PipeDecoratorHandler(this.reflector, evaluator, scopeRegistry, this.isCore),
    ];

    return new IvyCompilation(
        handlers, checker, this.reflector, this.coreImportsFrom, this.sourceToFactorySymbols);
  }

  private get reflector(): TypeScriptReflectionHost {
    if (this._reflector === undefined) {
      this._reflector = new TypeScriptReflectionHost(this.tsProgram.getTypeChecker());
    }
    return this._reflector;
  }

  private get coreImportsFrom(): ts.SourceFile|null {
    if (this._coreImportsFrom === undefined) {
      this._coreImportsFrom = this.isCore && getR3SymbolsFile(this.tsProgram) || null;
    }
    return this._coreImportsFrom;
  }

  private get isCore(): boolean {
    if (this._isCore === undefined) {
      this._isCore = isAngularCorePackage(this.tsProgram);
    }
    return this._isCore;
  }
}

const defaultEmitCallback: api.TsEmitCallback =
    ({program, targetSourceFile, writeFile, cancellationToken, emitOnlyDtsFiles,
      customTransformers}) =>
        program.emit(
            targetSourceFile, writeFile, cancellationToken, emitOnlyDtsFiles, customTransformers);

function mergeEmitResults(emitResults: ts.EmitResult[]): ts.EmitResult {
  const diagnostics: ts.Diagnostic[] = [];
  let emitSkipped = false;
  const emittedFiles: string[] = [];
  for (const er of emitResults) {
    diagnostics.push(...er.diagnostics);
    emitSkipped = emitSkipped || er.emitSkipped;
    emittedFiles.push(...(er.emittedFiles || []));
  }
  return {diagnostics, emitSkipped, emittedFiles};
}

/**
 * Find the 'r3_symbols.ts' file in the given `Program`, or return `null` if it wasn't there.
 */
function getR3SymbolsFile(program: ts.Program): ts.SourceFile|null {
  return program.getSourceFiles().find(file => file.fileName.indexOf('r3_symbols.ts') >= 0) || null;
}

/**
 * Determine if the given `Program` is @angular/core.
 */
function isAngularCorePackage(program: ts.Program): boolean {
  // Look for its_just_angular.ts somewhere in the program.
  const r3Symbols = getR3SymbolsFile(program);
  if (r3Symbols === null) {
    return false;
  }

  // Look for the constant ITS_JUST_ANGULAR in that file.
  return r3Symbols.statements.some(stmt => {
    // The statement must be a variable declaration statement.
    if (!ts.isVariableStatement(stmt)) {
      return false;
    }
    // It must be exported.
    if (stmt.modifiers === undefined ||
        !stmt.modifiers.some(mod => mod.kind === ts.SyntaxKind.ExportKeyword)) {
      return false;
    }
    // It must declare ITS_JUST_ANGULAR.
    return stmt.declarationList.declarations.some(decl => {
      // The declaration must match the name.
      if (!ts.isIdentifier(decl.name) || decl.name.text !== 'ITS_JUST_ANGULAR') {
        return false;
      }
      // It must initialize the variable to true.
      if (decl.initializer === undefined || decl.initializer.kind !== ts.SyntaxKind.TrueKeyword) {
        return false;
      }
      // This definition matches.
      return true;
    });
  });
}

export class ReferenceGraphAdapter implements ReferencesRegistry {
  constructor(private graph: ReferenceGraph) {}

  add(source: ts.Declaration, ...references: Reference<ts.Declaration>[]): void {
    for (const {node} of references) {
      let sourceFile = node.getSourceFile();
      if (sourceFile === undefined) {
        sourceFile = ts.getOriginalNode(node).getSourceFile();
      }

      // Only record local references (not references into .d.ts files).
      if (sourceFile === undefined || !isDtsPath(sourceFile.fileName)) {
        this.graph.add(source, node);
      }
    }
  }
}
