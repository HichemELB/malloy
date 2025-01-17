/*
 * Copyright 2021 Google LLC
 *
 * This program is free software; you can redistribute it and/or
 * modify it under the terms of the GNU General Public License
 * version 2 as published by the Free Software Foundation.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 */

import { Connection } from "./connection";
import {
  DocumentHighlight as DocumentHighlightDefinition,
  DocumentSymbol as DocumentSymbolDefinition,
  LogMessage,
  MalloyTranslator,
} from "./lang";
import {
  CompiledQuery,
  FieldTypeDef,
  FilterExpression,
  ModelDef,
  Query as InternalQuery,
  QueryData,
  QueryModel,
  QueryResult,
  StructDef,
  TurtleDef,
} from "./model";
import {
  LookupSQLRunner,
  LookupSchemaReader,
  ModelString,
  ModelURL,
  QueryString,
  QueryURL,
  URL,
  URLReader,
} from "./runtime_types";

export interface Loggable {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  debug: (message?: any, ...optionalParams: any[]) => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  info: (message?: any, ...optionalParams: any[]) => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  warn: (message?: any, ...optionalParams: any[]) => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  error: (message?: any, ...optionalParams: any[]) => void;
}

export class Malloy {
  // TODO load from file built during release
  public static get version(): string {
    return "0.0.1";
  }

  public static db: Connection;
  private static _log: Loggable;

  public static get log(): Loggable {
    return Malloy._log || console;
  }

  public static setLogger(log: Loggable): void {
    Malloy._log = log;
  }

  private static _parse(source: string, url?: URL): Parse {
    if (url === undefined) {
      url = URL.fromString("internal://internal.malloy");
    }
    const translator = new MalloyTranslator(url.toString(), {
      urls: { [url.toString()]: source },
    });
    return new Parse(translator);
  }

  /**
   * Parse a Malloy document by URL.
   *
   * @param url The URL of the Malloy document to parse.
   * @param urlReader Object capable of fetching URL contents.
   * @returns A (promise of a) `Parse` result.
   */
  public static parse({
    url,
    urlReader,
  }: {
    url: URL;
    urlReader: URLReader;
  }): Promise<Parse>;
  /**
   * Parse a Malloy document by contents.
   *
   * @param url The URL of the Malloy document to parse (optional).
   * @param source The contents of the Malloy document to parse.
   * @returns A `Parse` result.
   */
  public static parse({ source, url }: { url?: URL; source: string }): Parse;
  public static parse({
    url,
    urlReader,
    source,
  }: {
    url?: URL;
    source?: string;
    urlReader?: URLReader;
  }): Parse | Promise<Parse> {
    if (source !== undefined) {
      return Malloy._parse(source, url);
    } else {
      if (urlReader === undefined) {
        throw new Error("Internal Error: urlReader is required.");
      }
      if (url === undefined) {
        throw new Error(
          "Internal Error: url is required if source not present."
        );
      }
      return urlReader.readURL(url).then((source) => {
        return Malloy._parse(source, url);
      });
    }
  }

  /**
   * Compile a parsed Malloy document.
   *
   * @param urlReader Object capable of reading contents of a URL.
   * @param lookupSchemaReader Mapping of connection names to objects capable of reading Malloy schemas.
   * @param parse The parsed Malloy document.
   * @param model A compiled model to build upon (optional).
   * @returns A (promise of a) compiled `Model`.
   */
  public static async compile({
    urlReader,
    lookupSchemaReader,
    parse,
    model,
  }: {
    urlReader: URLReader;
    lookupSchemaReader: LookupSchemaReader;
    parse: Parse;
    model?: Model;
  }): Promise<Model> {
    const translator = parse._getTranslator();
    translator.translate(model?._getModelDef());
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const result = translator.translate();
      if (result.final) {
        if (result.translated) {
          return new Model(
            result.translated.modelDef,
            result.translated.queryList
          );
        } else {
          const errors = result.errors || [];
          throw new MalloyError(
            `Error(s) compiling model: ${errors[0]?.message}.`,
            errors
          );
        }
      } else if (result.urls) {
        for (const neededUrl of result.urls) {
          if (neededUrl.startsWith("internal://")) {
            throw new Error(
              "In order to use relative imports, you must compile a file via a URL."
            );
          }
          const neededText = await urlReader.readURL(URL.fromString(neededUrl));
          const urls = { [neededUrl]: neededText };
          translator.update({ urls });
        }
      } else if (result.tables) {
        // collect tables by connection name since there may be multiple connections
        const tablesByConnection: Map<
          string | undefined,
          Array<string>
        > = new Map();
        for (const connectionTableString of result.tables) {
          const { connectionName, tableName } = parseTableName(
            connectionTableString
          );

          let connectionToTablesMap = tablesByConnection.get(connectionName);
          if (!connectionToTablesMap) {
            connectionToTablesMap = [tableName];
          } else {
            connectionToTablesMap.push(tableName);
          }
          tablesByConnection.set(connectionName, connectionToTablesMap);
        }

        // iterate over connections, fetching schema for all missing tables
        for (const [connectionName, tableNames] of tablesByConnection) {
          const schemaFetcher = await lookupSchemaReader.lookupSchemaReader(
            connectionName
          );
          const tables = await schemaFetcher.fetchSchemaForTables(tableNames);
          translator.update({ tables });
        }
      }
    }
  }

  /**
   * Run a fully-prepared query.
   *
   * @param lookupSQLRunner A mapping from connection names to objects capable of running SQL.
   * @param preparedResult A fully-prepared query which is ready to run (a `PreparedResult`).
   * @returns Query result data and associated metadata.
   */
  public static async run({
    lookupSQLRunner,
    preparedResult,
  }: {
    lookupSQLRunner: LookupSQLRunner;
    preparedResult: PreparedResult;
  }): Promise<Result> {
    const sqlRunner = await lookupSQLRunner.lookupSQLRunner(
      preparedResult.getConnectionName()
    );
    const result = await sqlRunner.runSQL(preparedResult.getSQL());
    return new Result({
      ...preparedResult._getRawQuery(),
      result: result.rows,
      totalRows: result.totalRows,
    });
  }
}

/**
 * A Malloy error, which may contain log messages produced during compilation.
 */
export class MalloyError extends Error {
  /**
   * An array of log messages produced during compilation.
   */
  public readonly log: LogMessage[];

  constructor(message: string, log: LogMessage[] = []) {
    super(message);
    this.log = log;
  }
}

/**
 * A compiled Malloy document.
 */
export class Model {
  private modelDef: ModelDef;
  private queryList: InternalQuery[];

  constructor(modelDef: ModelDef, queryList: InternalQuery[]) {
    this.modelDef = modelDef;
    this.queryList = queryList;
  }

  /**
   * Retrieve a prepared query by the name of a query at the top level of the model.
   *
   * @param queryName Name of the query to retrieve.
   * @returns A prepared query.
   */
  public getPreparedQueryByName(queryName: string): PreparedQuery {
    const struct = this.modelDef.structs[queryName];
    if (struct.type === "struct") {
      const source = struct.structSource;
      if (source.type === "query") {
        return new PreparedQuery(source.query, this.modelDef, queryName);
      }
    }

    throw new Error("Given query name does not refer to a named query.");
  }

  /**
   * Retrieve a prepared query by the index of an unnamed query at the top level of a model.
   *
   * @param index The index of the query to retrieve.
   * @returns A prepared query.
   */
  public getPreparedQueryByIndex(index: number): PreparedQuery {
    if (index < 0) {
      throw new Error(`Invalid index ${index}.`);
    } else if (index >= this.queryList.length) {
      throw new Error(`Query index ${index} is out of bounds.`);
    }
    return new PreparedQuery(this.queryList[index], this.modelDef);
  }

  /**
   * Retrieve a prepared query for the final unnamed query at the top level of a model.
   *
   * @returns A prepared query.
   */
  public getPreparedQuery(): PreparedQuery {
    if (this.queryList.length < 0) {
      throw new Error("Model has no queries.");
    }
    return new PreparedQuery(
      this.queryList[this.queryList.length - 1],
      this.modelDef
    );
  }

  /**
   * Retrieve an `Explore` from the model by name.
   *
   * @param name The name of the `Explore` to retrieve.
   * @returns An `Explore`.
   */
  public getExploreByName(name: string): Explore {
    return new Explore(this.modelDef.structs[name]);
  }

  /**
   * Get an array of `Explore`s contained in the model.
   *
   * @returns An array of `Explore`s contained in the model.
   */
  public getExplores(): Explore[] {
    return Object.keys(this.modelDef.structs).map((name) =>
      this.getExploreByName(name)
    );
  }

  public _getModelDef(): ModelDef {
    return this.modelDef;
  }
}

/**
 * A prepared query which has all the necessary information to produce its SQL.
 */
export class PreparedQuery {
  private _modelDef: ModelDef;
  private _query: InternalQuery;
  private name?: string;

  constructor(query: InternalQuery, model: ModelDef, name?: string) {
    this._query = query;
    this._modelDef = model;
    this.name = name;
  }

  /**
   * Generate the SQL for this query.
   *
   * @returns A fully-prepared query (which contains the generated SQL).
   */
  public getPreparedResult(): PreparedResult {
    const queryModel = new QueryModel(this._modelDef);
    const translatedQuery = queryModel.compileQuery(this._query);
    return new PreparedResult({
      queryName: this.name || translatedQuery.queryName,
      ...translatedQuery,
    });
  }
}

function parseTableName(connectionTableString: string) {
  const [firstPart, secondPart] = connectionTableString.split(":");
  if (secondPart) {
    return { connectionName: firstPart, tableName: secondPart };
  } else {
    return { tableName: firstPart };
  }
}

/**
 * A parsed Malloy document.
 */
export class Parse {
  private translator: MalloyTranslator;

  constructor(translator: MalloyTranslator) {
    this.translator = translator;
  }

  /**
   * Retrieve the document highlights for the parsed document.
   *
   * These highlights represent the parsed tokens contained in the document,
   * and may be used for syntax highlighting in an IDE, for example.
   *
   * @returns An array of document highlights.
   */
  public getHighlights(): DocumentHighlight[] {
    return (this.translator.metadata().highlights || []).map(
      (highlight) => new DocumentHighlight(highlight)
    );
  }

  /**
   * Retrieve the symbols defined in the parsed document.
   *
   * These symbols represent any object defined (e.g. `Query`s and `Explore`s)
   * in the document.
   *
   * @returns An array of document symbols.
   */
  public getSymbols(): DocumentSymbol[] {
    return (this.translator.metadata().symbols || []).map(
      (symbol) => new DocumentSymbol(symbol)
    );
  }

  public _getTranslator(): MalloyTranslator {
    return this.translator;
  }
}

/**
 * A document highlight.
 *
 * Represents a parsed token contained in a Malloy document
 * and may be used for syntax highlighting in an IDE, for example.
 */
export class DocumentHighlight {
  private range: DocumentRange;
  private type: string;

  constructor(documentHighlight: DocumentHighlightDefinition) {
    this.range = new DocumentRange(
      new DocumentPosition(
        documentHighlight.range.start.line,
        documentHighlight.range.start.character
      ),
      new DocumentPosition(
        documentHighlight.range.end.line,
        documentHighlight.range.end.character
      )
    );
    this.type = documentHighlight.type;
  }

  /**
   * @returns The range of characters this highlight spans within its source document.
   */
  getRange(): DocumentRange {
    return this.range;
  }

  /**
   * @returns The type of highlight, which may be any `HighlightType`.
   */
  getType(): string {
    return this.type;
  }
}

/**
 * A range of characters within a Malloy document.
 */
export class DocumentRange {
  private start: DocumentPosition;
  private end: DocumentPosition;

  constructor(start: DocumentPosition, end: DocumentPosition) {
    this.start = start;
    this.end = end;
  }

  /**
   * @returns The position of the first character in the range.
   */
  public getStart(): DocumentPosition {
    return this.start;
  }

  /**
   * @returns The position of the last character in the range.
   */
  public getEnd(): DocumentPosition {
    return this.end;
  }

  /**
   * @returns This range in JSON format.
   */
  public toJSON(): {
    start: { line: number; character: number };
    end: { line: number; character: number };
  } {
    return {
      start: this.start.toJSON(),
      end: this.end.toJSON(),
    };
  }
}

/**
 * A position within a Malloy document.
 */
export class DocumentPosition {
  private line: number;
  private character: number;

  constructor(line: number, character: number) {
    this.line = line;
    this.character = character;
  }

  /**
   * @returns The line number of the position.
   */
  public getLine(): number {
    return this.line;
  }

  /**
   * @returns The character index on the line `this.getLine()`.
   */
  public getCharacter(): number {
    return this.character;
  }

  /**
   * @returns This position in JSON format.
   */
  public toJSON(): { line: number; character: number } {
    return { line: this.line, character: this.character };
  }
}

/**
 * A symbol defined in a Malloy document.
 *
 * Represents any object defined (e.g. `Query`s and `Explore`s) in the document.
 */
export class DocumentSymbol {
  private range: DocumentRange;
  private type: string;
  private name: string;
  private children: DocumentSymbol[];

  constructor(documentSymbol: DocumentSymbolDefinition) {
    this.range = new DocumentRange(
      new DocumentPosition(
        documentSymbol.range.start.line,
        documentSymbol.range.start.character
      ),
      new DocumentPosition(
        documentSymbol.range.end.line,
        documentSymbol.range.end.character
      )
    );
    this.type = documentSymbol.type;
    this.name = documentSymbol.name;
    this.children = documentSymbol.children.map(
      (child) => new DocumentSymbol(child)
    );
  }

  /**
   * @returns The range of characters in the source Malloy document that define this symbol.
   */
  public getRange(): DocumentRange {
    return this.range;
  }

  /**
   * @returns The type of symbol.
   *
   * Possible values are: `"explore"`, `"query"`, `"field"`, `"turtle"`, `"join"`, or `"unnamed_query"`.
   */
  public getType(): string {
    return this.type;
  }

  /**
   * @returns The name of this symbol, e.g. the `Explore` name or `Query` name.
   *
   * For type `"unnamed_query"`, `getName()` is `"unnamed_query"`.
   */
  public getName(): string {
    return this.name;
  }

  /**
   * @returns An array of document symbols defined inside this document symbol,
   * e.g. fields in an `Explore`.
   */
  public getChildren(): DocumentSymbol[] {
    return this.children;
  }
}

/**
 * A fully-prepared query containing SQL and metadata required to run the query.
 */
export class PreparedResult {
  protected inner: CompiledQuery;

  constructor(query: CompiledQuery) {
    this.inner = query;
  }

  /**
   * @returns The name of the connection this query should be run against.
   */
  public getConnectionName(): string {
    return this.inner.connectionName;
  }

  /**
   * @returns The SQL that should be run against the SQL runner
   * with the connection name `this.getConnectionName()`.
   */
  public getSQL(): string {
    return this.inner.sql;
  }

  /**
   * @returns The `Explore` representing the data that will be returned by running this query.
   */
  public getResultExplore(): Explore {
    if (this.inner.structs.length === 0) {
      throw new Error("Malformed query result.");
    }
    const explore = this.inner.structs[this.inner.structs.length - 1];
    const namedExplore = {
      ...explore,
      name: this.inner.queryName || explore.name,
    };
    return new Explore(namedExplore);
  }

  public _getRawQuery(): CompiledQuery {
    return this.inner;
  }

  public _getSourceExploreName(): string {
    return this.inner.sourceExplore;
  }

  public _getSourceFilters(): FilterExpression[] {
    return this.inner.sourceFilters || [];
  }
}

/**
 * A URL reader which always throws an error when a URL's contents is requested.
 *
 * Useful for scenarios in which `import` statements are not required.
 */
export class EmptyURLReader implements URLReader {
  async readURL(_url: URL): Promise<string> {
    throw new Error("No files.");
  }
}

/**
 * A URL reader backed by an in-memory mapping of URL contents.
 */
export class InMemoryURLReader implements URLReader {
  private files: Map<string, string>;

  constructor(files: Map<string, string>) {
    this.files = files;
  }

  public async readURL(url: URL): Promise<string> {
    const file = this.files.get(url.toString());
    if (file !== undefined) {
      return Promise.resolve(file);
    } else {
      throw new Error(`File not found '${url}'`);
    }
  }
}

/**
 * A fixed mapping of connection names to connections.
 */
export class FixedConnectionMap implements LookupSchemaReader, LookupSQLRunner {
  private connections: Map<string, Connection>;
  private defaultConnectionName?: string;
  constructor(
    connections: Map<string, Connection>,
    defaultConnectionName?: string
  ) {
    this.connections = connections;
    this.defaultConnectionName = defaultConnectionName;
  }

  /**
   * Get a connection by name.
   *
   * @param connectionName The name of the connection to look up.
   * @returns A `Connection`
   * @throws An `Error` if no connection with the given name exists.
   */
  public async getConnection(connectionName?: string): Promise<Connection> {
    if (connectionName === undefined) {
      if (this.defaultConnectionName !== undefined) {
        connectionName = this.defaultConnectionName;
      } else {
        throw new Error("No default connection.");
      }
    }

    const connection = this.connections.get(connectionName);
    if (connection !== undefined) {
      return Promise.resolve(connection);
    } else {
      throw new Error(`No connection found with name ${connectionName}.`);
    }
  }

  public async lookupSchemaReader(
    connectionName?: string
  ): Promise<Connection> {
    return this.getConnection(connectionName);
  }

  public async lookupSQLRunner(connectionName?: string): Promise<Connection> {
    return this.getConnection(connectionName);
  }
}

/**
 * The relationship of an `Explore` to its source.
 */
export enum SourceRelationship {
  /**
   * The `Explore` is nested data within the source's rows.
   */
  Nested = "nested",

  // TODO document this
  Condition = "condition",

  /**
   * The `Explore` is the base table.
   */
  BaseTable = "base_table",

  /**
   * The `Explore` is joined to its source by a foreign key.
   */
  ForeignKey = "foreign_key",

  // TODO document this
  Inline = "inline",
}

export type Field = AtomicField | QueryField | ExploreField;

/**
 * An explore contained within a Malloy document.
 */
export class Explore {
  protected readonly structDef: StructDef;
  protected readonly parentExplore?: Explore;
  private fields: Map<string, Field> | undefined;

  constructor(structDef: StructDef, parentExplore?: Explore) {
    this.structDef = structDef;
    this.parentExplore = parentExplore;
  }

  /**
   * @returns The name of the explore.
   */
  public getName(): string {
    return this.structDef.as || this.structDef.name;
  }

  public getQueryByName(name: string): PreparedQuery {
    const internalQuery: InternalQuery = {
      type: "query",
      structRef: this.structDef,
      pipeline: [
        {
          type: "reduce",
          fields: [name],
        },
      ],
    };
    return new PreparedQuery(internalQuery, this.getModelDef());
  }

  private getModelDef(): ModelDef {
    return {
      name: "generated_model",
      exports: [],
      structs: { [this.structDef.name]: this.structDef },
    };
  }

  public getSingleExploreModel(): Model {
    return new Model(this.getModelDef(), []);
  }

  private getFieldMap(): Map<string, Field> {
    if (this.fields === undefined) {
      this.fields = new Map(
        this.structDef.fields.map((fieldDef) => {
          const name = fieldDef.as || fieldDef.name;
          if (fieldDef.type === "struct") {
            return [name, new ExploreField(fieldDef, this)];
          } else if (fieldDef.type === "turtle") {
            return [name, new QueryField(fieldDef)];
          } else {
            return [name, new AtomicField(fieldDef)];
          }
        }) as [string, Field][]
      );
    }
    return this.fields;
  }

  public getFields(): Field[] {
    return [...this.getFieldMap().values()];
  }

  public getFieldByName(fieldName: string): Field {
    const field = this.getFieldMap().get(fieldName);
    if (field === undefined) {
      throw new Error(`No such field ${fieldName}.`);
    }
    return field;
  }

  public getPrimaryKey(): string | undefined {
    return this.structDef.primaryKey;
  }

  public getParentExplore(): Explore | undefined {
    return this.parentExplore;
  }

  public getSourceRelationship(): SourceRelationship {
    switch (this.structDef.structRelationship.type) {
      case "condition":
        return SourceRelationship.Condition;
      case "foreignKey":
        return SourceRelationship.ForeignKey;
      case "inline":
        return SourceRelationship.Inline;
      case "nested":
        return SourceRelationship.Nested;
      case "basetable":
        return SourceRelationship.BaseTable;
    }
  }

  public hasParentExplore(): this is ExploreField {
    return this instanceof ExploreField;
  }

  public _getStructDef(): StructDef {
    return this.structDef;
  }
}

export enum AtomicFieldType {
  String = "string",
  Number = "number",
  Boolean = "boolean",
  Date = "date",
  Timestamp = "timestamp",
}

export class AtomicField {
  private fieldTypeDef: FieldTypeDef;

  constructor(fieldTypeDef: FieldTypeDef) {
    this.fieldTypeDef = fieldTypeDef;
  }

  public getName(): string {
    return this.fieldTypeDef.as || this.fieldTypeDef.name;
  }

  public getType(): AtomicFieldType {
    switch (this.fieldTypeDef.type) {
      case "string":
        return AtomicFieldType.String;
      case "boolean":
        return AtomicFieldType.Boolean;
      case "date":
        return AtomicFieldType.Date;
      case "timestamp":
        return AtomicFieldType.Timestamp;
      case "number":
        return AtomicFieldType.Number;
    }
  }

  public isQueryField(): this is QueryField {
    return false;
  }

  public isExploreField(): this is ExploreField {
    return false;
  }

  public isAtomicField(): this is AtomicField {
    return true;
  }

  public isAggregate(): boolean {
    return !!this.fieldTypeDef.aggregate;
  }
}

export class QueryField {
  private turtleDef: TurtleDef;

  constructor(turtleDef: TurtleDef) {
    this.turtleDef = turtleDef;
  }

  public getName(): string {
    return this.turtleDef.as || this.turtleDef.name;
  }

  public isQueryField(): this is QueryField {
    return true;
  }

  public isExploreField(): this is ExploreField {
    return false;
  }

  public isAtomicField(): this is AtomicField {
    return false;
  }
}

export enum JoinRelationship {
  OneToOne = "one_to_one",
  OneToMany = "one_to_many",
  ManyToOne = "many_to_one",
}

export class ExploreField extends Explore {
  protected parentExplore: Explore;

  constructor(structDef: StructDef, parentExplore: Explore) {
    super(structDef, parentExplore);
    this.parentExplore = parentExplore;
  }

  public getJoinRelationship(): JoinRelationship {
    switch (this.structDef.structRelationship.type) {
      case "condition":
      case "foreignKey":
        return JoinRelationship.OneToMany;
      case "inline":
        return JoinRelationship.OneToOne;
      case "nested":
        return JoinRelationship.ManyToOne;
      default:
        throw new Error("An explore field must have a join relationship.");
    }
  }

  public isQueryField(): this is QueryField {
    return false;
  }

  public isExploreField(): this is ExploreField {
    return true;
  }

  public isAtomicField(): this is AtomicField {
    return false;
  }

  public getParentExplore(): Explore {
    return this.parentExplore;
  }
}

/**
 * An environment for compiling and running Malloy queries.
 */
export class Runtime {
  private urlReader: URLReader;
  private lookupSchemaReader: LookupSchemaReader;
  private lookupSQLRunner: LookupSQLRunner;

  constructor(runtime: LookupSchemaReader & LookupSQLRunner & URLReader);
  constructor(
    urls: URLReader,
    connections: LookupSchemaReader & LookupSQLRunner
  );
  constructor(
    urls: URLReader,
    schemas: LookupSchemaReader,
    connections: LookupSQLRunner
  );
  constructor(connections: LookupSchemaReader & LookupSQLRunner);
  constructor(schemas: LookupSchemaReader, connections: LookupSQLRunner);
  constructor(...args: (URLReader | LookupSchemaReader | LookupSQLRunner)[]) {
    let urlReader: URLReader | undefined;
    let lookupSchemaReader: LookupSchemaReader | undefined;
    let lookupSQLRunner: LookupSQLRunner | undefined;
    for (const arg of args) {
      if (isURLReader(arg)) {
        urlReader = arg;
      }
      if (isLookupSchemaReader(arg)) {
        lookupSchemaReader = arg;
      }
      if (isLookupSQLRunner(arg)) {
        lookupSQLRunner = arg;
      }
    }
    if (urlReader === undefined) {
      urlReader = new EmptyURLReader();
    }
    if (lookupSchemaReader === undefined) {
      throw new Error("A LookupSchemaReader is required.");
    }
    if (lookupSQLRunner === undefined) {
      throw new Error("A LookupSQLReader is required.");
    }
    this.urlReader = urlReader;
    this.lookupSQLRunner = lookupSQLRunner;
    this.lookupSchemaReader = lookupSchemaReader;
  }

  /**
   * @returns The `URLReader` for this runtime instance.
   */
  public getURLReader(): URLReader {
    return this.urlReader;
  }

  /**
   * @returns The `LookupSQLRunner` for this runtime instance.
   */
  public getLookupSQLRunner(): LookupSQLRunner {
    return this.lookupSQLRunner;
  }

  /**
   * @returns The `LookupSchemaReader` for this runtime instance.
   */
  public getLookupSchemaReader(): LookupSchemaReader {
    return this.lookupSchemaReader;
  }

  /**
   * Load a Malloy model by URL or contents.
   *
   * @param source The model URL or contents to load and (eventually) compile.
   * @returns A `ModelMaterializer` capable of materializing the requested model,
   * or loading further related objects.
   */
  public loadModel(source: ModelURL | ModelString): ModelMaterializer {
    return new ModelMaterializer(this, async () => {
      const parse =
        source instanceof URL
          ? await Malloy.parse({
              url: source,
              urlReader: this.urlReader,
            })
          : Malloy.parse({
              source,
            });
      return Malloy.compile({
        urlReader: this.urlReader,
        lookupSchemaReader: this.lookupSchemaReader,
        parse,
      });
    });
  }

  // TODO Consider formalizing this. Perhaps as a `withModel` method,
  //      as well as a `Model.fromModelDefinition` if we choose to expose
  //      `ModelDef` to the world formally. For now, this should only
  //      be used in tests.
  public _loadModelFromModelDef(modelDef: ModelDef): ModelMaterializer {
    return new ModelMaterializer(this, async function materialize() {
      return new Model(modelDef, []);
    });
  }

  /**
   * Load a Malloy query by URL or contents.
   *
   * @param query The query URL or contents to load and (eventually) compile.
   * @returns A `QueryMaterializer` capable of materializing the requested query, running it,
   * or loading further related objects.
   */
  public loadQuery(query: QueryURL | QueryString): QueryMaterializer {
    return this.loadModel(query).loadFinalQuery();
  }

  /**
   * Load a Malloy query by the URL or contents of a Malloy model document
   * and the index of an unnamed query contained in the model.
   *
   * @param model The model URL or contents to load and (eventually) compile to retrieve the requested query.
   * @param index The index of the query to use within the model.
   * @returns A `QueryMaterializer` capable of materializing the requested query, running it,
   * or loading further related objects.
   */
  public loadQueryByIndex(
    model: ModelURL | ModelString,
    index: number
  ): QueryMaterializer {
    return this.loadModel(model).loadQueryByIndex(index);
  }

  /**
   * Load a Malloy query by the URL or contents of a Malloy model document
   * and the name of a query contained in the model.
   *
   * @param model The model URL or contents to load and (eventually) compile to retrieve the requested query.
   * @param name The name of the query to use within the model.
   * @returns A `QueryMaterializer` capable of materializing the requested query, running it,
   * or loading further related objects.
   */
  public loadQueryByName(
    model: ModelURL | ModelString,
    name: string
  ): QueryMaterializer {
    return this.loadModel(model).loadQueryByName(name);
  }

  // TODO maybe use overloads for the alternative parameters
  /**
   * Compile a Malloy model by URL or contents.
   *
   * @param source The URL or contents of a Malloy model document to compile.
   * @returns A promise of a compiled `Model`.
   */
  public getModel(source: ModelURL | ModelString): Promise<Model> {
    return this.loadModel(source).getModel();
  }

  /**
   * Compile a Malloy query by URL or contents.
   *
   * @param query The URL or contents of a Malloy query document to compile.
   * @returns A promise of a compiled `PreparedQuery`.
   */
  public getQuery(query: QueryURL | QueryString): Promise<PreparedQuery> {
    return this.loadQuery(query).getPreparedQuery();
  }

  /**
   * Compile a Malloy query by the URL or contents of a model document
   * and the index of an unnamed query contained within the model.
   *
   * @param model The URL or contents of a Malloy model document to compile.
   * @param index The index of an unnamed query contained within the model.
   * @returns A promise of a compiled `PreparedQuery`.
   */
  public getQueryByIndex(
    model: ModelURL | ModelString,
    index: number
  ): Promise<PreparedQuery> {
    return this.loadQueryByIndex(model, index).getPreparedQuery();
  }

  /**
   * Compile a Malloy query by the URL or contents of a model document
   * and the name of a query contained within the model.
   *
   * @param model The URL or contents of a Malloy model document to compile.
   * @param name The name of a query contained within the model.
   * @returns A promise of a compiled `PreparedQuery`.
   */
  public getQueryByName(
    model: ModelURL | ModelString,
    name: string
  ): Promise<PreparedQuery> {
    return this.loadQueryByName(model, name).getPreparedQuery();
  }
}

class FluentState<T> {
  protected runtime: Runtime;
  private readonly _materialize: () => Promise<T>;
  private materialized: Promise<T> | undefined;

  constructor(runtime: Runtime, materialize: () => Promise<T>) {
    this.runtime = runtime;
    this._materialize = materialize;
  }

  protected materialize(): Promise<T> {
    if (this.materialized === undefined) {
      return this.rematerialize();
    }
    return this.materialized;
  }

  protected rematerialize(): Promise<T> {
    this.materialized = this._materialize();
    return this.materialized;
  }

  protected makeQueryMaterializer(
    materialize: () => Promise<PreparedQuery>
  ): QueryMaterializer {
    return new QueryMaterializer(this.runtime, materialize);
  }

  protected makeExploreMaterializer(
    materialize: () => Promise<Explore>
  ): ExploreMaterializer {
    return new ExploreMaterializer(this.runtime, materialize);
  }

  protected makePreparedResultMaterializer(
    materialize: () => Promise<PreparedResult>
  ): PreparedResultMaterializer {
    return new PreparedResultMaterializer(this.runtime, materialize);
  }
}

/**
 * An object representing the task of loading a `Model`, capable of
 * materializing that model (via `getModel()`) or extending the task to load
 * queries or explores (via e.g. `loadFinalQuery()`, `loadQuery`, `loadExploreByName`, etc.).
 */
export class ModelMaterializer extends FluentState<Model> {
  /**
   * Load the final (unnamed) Malloy query contained within this loaded `Model`.
   *
   * @returns A `QueryMaterializer` capable of materializing the requested query, running it,
   * or loading further related objects.
   */
  public loadFinalQuery(): QueryMaterializer {
    return this.makeQueryMaterializer(async () => {
      return (await this.materialize()).getPreparedQuery();
    });
  }

  /**
   * Load an unnamed query contained within this loaded `Model` by index.
   *
   * @param index The index of the query to load.
   * @returns A `QueryMaterializer` capable of materializing the requested query, running it,
   * or loading further related objects.
   */
  public loadQueryByIndex(index: number): QueryMaterializer {
    return this.makeQueryMaterializer(async () => {
      return (await this.materialize()).getPreparedQueryByIndex(index);
    });
  }

  /**
   * Load a query contained within this loaded `Model` by its name.
   *
   * @param name The name of the query to load.
   * @returns A `QueryMaterializer` capable of materializing the requested query, running it,
   * or loading further related objects.
   */
  public loadQueryByName(name: string): QueryMaterializer {
    return this.makeQueryMaterializer(async () => {
      return (await this.materialize()).getPreparedQueryByName(name);
    });
  }

  /**
   * Load a query against this loaded `Model` by its URL or contents.
   *
   * @param query The URL or contents of the query to load and (eventually) compile.
   * @returns A `QueryMaterializer` capable of materializing the requested query, running it,
   * or loading further related objects.
   */
  public loadQuery(query: QueryString | QueryURL): QueryMaterializer {
    return this.makeQueryMaterializer(async () => {
      const urlReader = this.runtime.getURLReader();
      const lookupSchemaReader = this.runtime.getLookupSchemaReader();
      const parse =
        query instanceof URL
          ? await Malloy.parse({
              url: query,
              urlReader: urlReader,
            })
          : Malloy.parse({
              source: query,
            });
      const model = await this.getModel();
      const queryModel = await Malloy.compile({
        urlReader,
        lookupSchemaReader,
        parse,
        model,
      });
      return queryModel.getPreparedQuery();
    });
  }

  /**
   * Materialize the final query contained within this loaded `Model`.
   *
   * @returns A promise to a prepared query.
   */
  public getFinalQuery(): Promise<PreparedQuery> {
    return this.loadFinalQuery().getPreparedQuery();
  }

  /**
   * Materialize an unnamed query contained within this loaded `Model` by index.
   *
   * @param index The index of the query contained within this loaded `Model`.
   * @returns A promise to a prepared query.
   */
  public getQueryByIndex(index: number): Promise<PreparedQuery> {
    return this.loadQueryByIndex(index).getPreparedQuery();
  }

  /**
   * Materialize a query contained within this loaded `Model` by name.
   *
   * @param name The name of the query contained within this loaded `Model`.
   * @returns A promise to a prepared query.
   */
  public getQueryByName(name: string): Promise<PreparedQuery> {
    return this.loadQueryByName(name).getPreparedQuery();
  }

  /**
   * Materialize a query against this loaded `Model` by its URL or contents.
   *
   * @param query The URL or contents of a query document to compile.
   * @returns A promise to a prepared query.
   */
  public getQuery(query: QueryString | QueryURL): Promise<PreparedQuery> {
    return this.loadQuery(query).getPreparedQuery();
  }

  // TODO Consider formalizing this. Perhaps as a `withQuery` method,
  //      as well as a `PreparedQuery.fromQueryDefinition` if we choose to expose
  //      `InternalQuery` to the world formally. For now, this should only
  //      be used in tests.
  public _loadQueryFromQueryDef(query: InternalQuery): QueryMaterializer {
    return this.makeQueryMaterializer(async () => {
      const model = await this.materialize();
      return new PreparedQuery(query, model._getModelDef());
    });
  }

  /**
   * Load an explore contained within this loaded `Model` by name.
   *
   * @param name The name of the explore contained within this loaded `Model`.
   * @returns An `ExploreMaterializer` capable of materializing the requested explore,
   * or loading further related objects.
   */
  public loadExploreByName(name: string): ExploreMaterializer {
    return this.makeExploreMaterializer(async () => {
      return (await this.materialize()).getExploreByName(name);
    });
  }

  /**
   * Materialize an explore contained within this loaded `Model` by its name.
   *
   * @param query The name of an explore within this loaded `Model`.
   * @returns A promise to an explore.
   */
  public getExploreByName(name: string): Promise<Explore> {
    return this.loadExploreByName(name).getExplore();
  }

  /**
   * Compile and materialize this loaded `Model`.
   *
   * @returns A promise to the compiled model that is loaded.
   */
  public getModel(): Promise<Model> {
    return this.materialize();
  }
}

/**
 * An object representing the task of loading a `Query`, capable of
 * materializing the query (via `getPreparedQuery()`) or extending the task to load
 * prepared results or run the query (via e.g. `loadPreparedResult()` or `run()`).
 */
class QueryMaterializer extends FluentState<PreparedQuery> {
  /**
   * Run this loaded `Query`.
   *
   * @returns The query results from running this loaded query.
   */
  async run(): Promise<Result> {
    const lookupSQLRunner = this.runtime.getLookupSQLRunner();
    const preparedResult = await this.getPreparedResult();
    return Malloy.run({ lookupSQLRunner, preparedResult });
  }

  /**
   * Load the prepared result of this loaded query.
   *
   * @returns A `PreparedResultMaterializer` capable of materializing the requested
   * prepared query or running it.
   */
  public loadPreparedResult(): PreparedResultMaterializer {
    return this.makePreparedResultMaterializer(async () => {
      return (await this.materialize()).getPreparedResult();
    });
  }

  /**
   * Materialize the prepared result of this loaded query.
   *
   * @returns A promise of the prepared result of this loaded query.
   */
  public getPreparedResult(): Promise<PreparedResult> {
    return this.loadPreparedResult().getPreparedResult();
  }

  /**
   * Materialize the SQL of this loaded query.
   *
   * @returns A promise of the SQL string.
   */
  public async getSQL(): Promise<string> {
    return (await this.getPreparedResult()).getSQL();
  }

  /**
   * Materialize this loaded query.
   *
   * @returns A promise of the `PreparedQuery`.
   */
  public getPreparedQuery(): Promise<PreparedQuery> {
    return this.materialize();
  }
}

/**
 * An object representing the task of loading a `PreparedResult`, capable of
 * materializing the prepared result (via `getPreparedResult()`) or extending the task run
 * the query.
 */
class PreparedResultMaterializer extends FluentState<PreparedResult> {
  /**
   * Run this prepared result.
   *
   * @returns A promise to the query result data.
   */
  async run(): Promise<Result> {
    const preparedResult = await this.getPreparedResult();
    const lookupSQLRunner = this.runtime.getLookupSQLRunner();
    return Malloy.run({ lookupSQLRunner, preparedResult });
  }

  /**
   * Materialize this loaded prepared result.
   *
   * @returns A promise of a prepared result.
   */
  public getPreparedResult(): Promise<PreparedResult> {
    return this.materialize();
  }

  /**
   * Materialize the SQL of this loaded prepared result.
   *
   * @returns A promise to the SQL string.
   */
  public async getSQL(): Promise<string> {
    return (await this.getPreparedResult()).getSQL();
  }
}

/**
 * An object representing the task of loading an `Explore`, capable of
 * materializing the explore (via `getExplore()`) or extending the task to produce
 * related queries.
 */
class ExploreMaterializer extends FluentState<Explore> {
  /**
   * Load a query contained within this loaded explore.
   *
   * @param name The name of the query to load.
   * @returns A `QueryMaterializer` capable of materializing the requested query, running it,
   * or loading further related objects.
   */
  public loadQueryByName(name: string): QueryMaterializer {
    return this.makeQueryMaterializer(async () => {
      return (await this.materialize()).getQueryByName(name);
    });
  }

  /**
   * Materialize a query contained within this loaded explore.
   *
   * @param name The name of the query to materialize.
   * @returns A promise to the requested prepared query.
   */
  public getQueryByName(name: string): Promise<PreparedQuery> {
    return this.loadQueryByName(name).getPreparedQuery();
  }

  /**
   * Materialize this loaded explore.
   *
   * @returns A promise to the compiled `Explore`.
   */
  public getExplore(): Promise<Explore> {
    return this.materialize();
  }
}

/**
 * The result of running a Malloy query.
 *
 * A `Result` is a `PreparedResult` along with the data retrieved from running the query.
 */
export class Result extends PreparedResult {
  protected inner: QueryResult;

  constructor(queryResult: QueryResult) {
    super(queryResult);
    this.inner = queryResult;
  }

  public _getQueryResult(): QueryResult {
    return this.inner;
  }

  /**
   * @returns The result data.
   */
  public getData(): DataArray {
    return new DataArray(this.inner.result, this.getResultExplore());
  }
}

/**
 * An array of query result data along with associated metadata.
 */
export class DataArray {
  private queryData: QueryData;
  protected field: Explore;

  constructor(queryData: QueryData, field: Explore) {
    this.queryData = queryData;
    this.field = field;
  }

  /**
   * @returns The `Explore` that describes the structure of this data.
   */
  public getField(): Explore {
    return this.field;
  }

  /**
   * @returns The raw object form of the data.
   */
  public toObject(): QueryData {
    return this.queryData;
  }
}

function isURLReader(
  thing: URLReader | LookupSchemaReader | LookupSQLRunner
): thing is URLReader {
  return "readURL" in thing;
}

function isLookupSchemaReader(
  thing: URLReader | LookupSchemaReader | LookupSQLRunner
): thing is LookupSchemaReader {
  return "lookupSchemaReader" in thing;
}

function isLookupSQLRunner(
  thing: URLReader | LookupSchemaReader | LookupSQLRunner
): thing is LookupSQLRunner {
  return "lookupSQLRunner" in thing;
}
