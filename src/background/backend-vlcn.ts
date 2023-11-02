import initWasm, { SQLite3, type DB } from "@vlcn.io/crsqlite-wasm";
// @ts-expect-error TS doesn't understand this?
import wasmUrl from "@vlcn.io/crsqlite-wasm/crsqlite.wasm?url";
import { } from '@vlcn.io/wa-sqlite'
import Turndown from "turndown";
import { formatDebuggablePayload, getArticleFragments, shasum } from "../common/utils";
import {
  Article,
  ArticleRow,
  Backend,
  DetailRow,
  RemoteProcWithSender,
  ResultRow,
} from "./backend";

type SQLiteArg = NonNullable<Parameters<DB['execO']>[1]>[number];
const argToSqlite = (v: unknown): SQLiteArg | undefined => {
 switch (typeof v) {
  case 'string':
  case 'number':
  case 'bigint':
    return v;

  case 'boolean': 
    return Number(v);        

  case 'symbol': 
    return v.toString();
  
  case 'function':
  default:
    if (Array.isArray(v)) {
      return v;
    } else if (v === null) {
      return v;
    } else if (typeof v === 'object' && v !== null) {
      return JSON.stringify(v);
    } else {
      return undefined;
    }
 }
}

const validate = (values: Record<string, unknown>) => {
    const keys: string[] = []
    const vals: SQLiteArg[] = []
    let invalid: Record<string, any> | undefined = undefined;

    for (const [k,v] of Object.entries(values)) {
      const x = argToSqlite(v);
      if (x !== undefined) {
        keys.push(k);
        vals.push(x); 
      } else {
        if (!invalid) invalid = {};
        invalid[k] = v;
      }
    }
    
    return { keys, vals, invalid };
  }

const SQLFormat = {
  /**
   * A template literal to make querying easier. Unlike the others this one just
   * takes a template string and tries to extract the variables into positoinal
  * args.
   */
   format: (strings: TemplateStringsArray, ...values: any[]) => {
     let str = '';
     const args: SQLiteArg[] = [];
    let invalid: Record<number, any> | undefined = undefined;
     
     strings.forEach((string, i) => {
       const v = argToSqlite(values[i]);
        if (v !== undefined) {
          str += string + '?';
          args.push(v);
        } else {
          if (!invalid) invalid = {};
          invalid[i] = values[i];
          str += string;
        }
     });

     return [str, args] as const;
   },
  
  insert: (table: string, values: Record<string, unknown>) => {
    const { keys, vals, invalid} = validate(values);
    const sql = `INSERT INTO ${table} (${keys.join(", ")}) VALUES (${keys
      .map(() => "?")
      .join(", ")})`;
      
    return [sql, vals, invalid] as const;
  },
  update: (table: string, values: Record<string, unknown>, condition: string) => {
    const { keys, vals, invalid } = validate(values);
    const sql = `UPDATE ${table} SET ${keys
      .map(key => `${key} = ?`)
      .join(", ")} WHERE ${condition}`;
      
    return [sql, vals, invalid] as const;
  }
}


// @note In order to avoid duplication, since we're indexing every URL the user
// visits, a document has a 1:n relationship with a URL. Multiple URLs can have
// the same document, for example text that says '404 not found'.
const migrations = [
  `
CREATE TABLE IF NOT EXISTS "document" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  "title" TEXT, 
  "url" TEXT UNIQUE NOT NULL,
  "excerpt" TEXT,
  "mdContent" TEXT,
  "mdContentHash" TEXT,
  "publicationDate" INTEGER,
  "hostname" TEXT,
  "lastVisit" INTEGER,
  "lastVisitDate" TEXT,
  "extractor" TEXT,
  "createdAt" INTEGER NOT NULL,
  "updatedAt" INTEGER
);
  `,

  `CREATE INDEX IF NOT EXISTS "document_hostname" ON "document" ("hostname");`,

]
const ftsMigrations =[
  `
CREATE TABLE IF NOT EXISTS "document_fragment" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  "entityId" INTEGER NOT NULL REFERENCES "document" ("id") ON DELETE CASCADE,
  "attribute" TEXT, 
  "value" TEXT,
  "order" INTEGER,
  "createdAt" INTEGER
);
  `,
  
  `
CREATE VIRTUAL TABLE "fts" USING fts5(
  entityId,
  attribute,
  value,
  tokenize='porter'
);
`,

  `
  CREATE TRIGGER "fts_ai" AFTER INSERT ON "document_fragment" BEGIN
    INSERT INTO "fts" ("rowid", "entityId", "attribute", "value") VALUES (new."id", new."entityId", new."attribute", new."value");
  END;
  `,

  `
  CREATE TRIGGER "fts_ad" AFTER DELETE ON "document_fragment" BEGIN
    DELETE FROM "fts" WHERE rowid=old."id";
  END;
  `,

  `
  CREATE TRIGGER IF NOT EXISTS "fts_au" AFTER UPDATE ON "document_fragment" BEGIN
    DELETE FROM "fts" WHERE rowid=old."id";
    INSERT INTO "fts" ("rowid", "entityId", "attribute", "value") VALUES (new."id", new."entityId", new."attribute", new."value");
  END;
    `,
];

/**
 * Run migrations against a database
 */
const migrate = async ({ migrations, db }: { migrations: string[], db: DB }) => {
  for (let sql of migrations) {
    sql = sql.trim(); // @note We really should also strip leading whitespace. this is to help avoid sql differing due to formatting

    const exists = await db.execO<{ id: number }>(
      `SELECT * FROM internal_migrations WHERE sql = ? LIMIT 1`,
      [sql]
    );

    if (exists.length) {
      console.debug("migration already run, skipping ::", exists[0].id);
      continue;
    }

    await db.exec(sql);
    await db.exec(`INSERT INTO internal_migrations (sql, date) VALUES (?, ?)`, [
      sql,
      new Date().toISOString(),
    ]);
  }
};


export class VLCN implements Backend {
  error: Error | null = null;

  getStatus: Backend["getStatus"] = async () => {
    if (this.error) {
      return {
        ok: false,
        error: this.error.message,
        detail: {
          stack: this.error.stack,
        }
      };
    }

    if (!this._dbReady) {
      return {
        ok: false,
        error: "db not ready",
      };
    }

    return {
      ok: true,
    }
  };

  getPageStatus: Backend["getPageStatus"] = async (payload, sender) => {
    const { tab } = sender;
    let shouldIndex = tab?.url?.startsWith("http"); // ignore chrome extensions, about:blank, etc

    try {
      const url = new URL(tab?.url || "");
      if (url.hostname === "localhost") shouldIndex = false;
      if (url.hostname.endsWith(".local")) shouldIndex = false;
      const existing = await this.findOne({ where: { url: url.href } });
      shouldIndex = !existing || !existing.mdContent; // Try to index if there is not yet any content
      if (existing) {
        this.touchDocument({
          id: existing.id,
          updatedAt: Date.now(),
          lastVisit: Date.now(),
          lastVisitDate: new Date().toISOString().split("T")[0],
        });
      }
    } catch (err) {
      // should not happen
      return {
        shouldIndex: false,
        error: err.message,
      };
    }

    console.log(`%c${"getPageStatus"}`, "color:lime;", { shouldIndex, url: tab?.url }, payload);

    return {
      shouldIndex,
    };
  };

  indexPage: Backend["indexPage"] = async (
    { /* htmlContent, */ date, textContent, mdContent, ...payload },
    sender
  ) => {
    const { tab } = sender;

    let mdContentHash: string | undefined = undefined;
    if (mdContent) {
      try {
        mdContentHash = await shasum(mdContent);
      } catch (err) {
        console.warn("shasum failed failed", err);
      }
    }

    const u = new URL(tab?.url || "");
    const document: Partial<ArticleRow> = {
      ...payload,
      mdContent,
      mdContentHash,
      publicationDate: date ? new Date(date).getTime() : undefined,
      url: u.href,
      hostname: u.hostname,
      lastVisit: Date.now(),
      lastVisitDate: new Date().toISOString().split("T")[0],
    };

    console.log(`%c${"indexPage"}`, "color:lime;", tab?.url);
    console.log(
      formatDebuggablePayload({
        title: document.title,
        textContent,
        siteName: document.siteName,
      })
    );

    const inserted = await this.upsertDocument(document);

    if (inserted) {
      console.log(
        `%c  ${"new insertion"}`,
        "color:gray;",
        `indexed doc:${inserted.id}, url:${u.href}`
      );

      await this.upsertFragments(inserted.id, {
        title: document.title,
        url: u.href,
        excerpt: document.excerpt,
        textContent,
      });
    }

    return {
      ok: true,
      message: `indexed doc:${mdContentHash}, url:${u.href}`,
    };
  };

  nothingToIndex: Backend["nothingToIndex"] = async (payload, sender) => {
    const { tab } = sender;
    console.log(`%c${"nothingToIndex"}`, "color:beige;", tab?.url);
    return {
      ok: true,
    };
  };

  search: Backend["search"] = async (payload) => {
    const { query, limit = 100, offset = 0 } = payload;
    console.log(`%c${"search"}`, "color:lime;", query);

    const startTime = performance.now();
    const [count, results] = await Promise.all([
      this.findOneRaw<{ count: number }>(`SELECT COUNT(*) as count FROM fts WHERE fts MATCH ?;`, [
        query,
      ]),
      // @note Ordering by date as a rasonable sorting mechanism. some sort of 'rank' woudl be better but fts3 does not have it out of the box.
      this.sql<ResultRow>`
      SELECT 
        fts.rowid,
        d.id as entityId,
        fts.attribute,
        SNIPPET(fts, -1, '<mark>', '</mark>', '…', 63) AS snippet,
        d.url,
        d.hostname,
        d.title,
        d.excerpt,
        d.lastVisit,
        d.lastVisitDate,
        d.mdContentHash,
        d.updatedAt,
        d.createdAt
      FROM fts
        INNER JOIN "document" d ON d.id = fts.entityId
      WHERE fts MATCH ${query}
      ORDER BY d.updatedAt DESC
      LIMIT ${limit}
      OFFSET ${offset};`
    ]);
    const endTime = performance.now();

    return {
      ok: true,
      results,
      count: count?.count,
      perfMs: endTime - startTime,
    };
  };

  // ------------------------------------------------------
  // implementation details
  //

  private upsertFragments = async (
    entityId: number,
    document: Partial<{ url: string; title: string; excerpt: string; textContent: string }>
  ) => {
    const fragments = getArticleFragments(document.textContent || "");

    // @note we NEED the 'OR IGNORE' as opposed to 'OR REPLACE' for now. The on
    // create trigger kept on firing so there were duplicate recors in the fts
    // table. might be solved by figuring out how to get FTS to use a text
    // primary key instead of rowid
    // Update: I think it's becuase insert or replace causes a new ROWID to be
    // written (also a new autoincrement id if that's what you used). This
    // causes the insert trigger on sqlite.
    const sql = `
      INSERT OR IGNORE INTO "document_fragment" (
        "entityId",
        "attribute",
        "value",
        "order"
      ) VALUES (
        ?,
        ?,
        ?,
        ?
      );
    `;

    console.log({ entityId, fragments });

    let params: [number, string, string, number][] = [];
    if (document.title) params.push([entityId, "title", document.title, 0]);
    if (document.excerpt) params.push([entityId, "excerpt", document.excerpt, 0]);
    if (document.url) params.push([entityId, "url", document.url, 0]);
    params = params.concat(
      fragments.map((fragment, i) => {
        return [entityId, "content", fragment, i];
      })
    );
    
    await this._db.tx(async (tx) => {
      for (const param of params) {
        await tx.exec(sql, param);
      }
    });

    return
  };

  private touchDocument = async (document: Partial<ArticleRow> & { id: number }) => {
    // update the document updatedAt time
    await this.sql`
        UPDATE "document" 
        SET updatedAt = ${document.updatedAt},
            lastVisit = ${document.lastVisit},
            lastVisitDate = ${document.lastVisitDate}
        WHERE id = ${document.id};
      `;
  };

  private upsertDocument = async (document: Partial<ArticleRow>) => {
    const doc = await this.findOneRaw<ArticleRow>(
      `
      SELECT id FROM "document" WHERE url = ?;
    `,
      [document.url]
    );

    if (doc) {
      // update the document updatedAt time
      const [sql, args, invalid] = SQLFormat.update(`document`, {
        updatedAt: Date.now(), 
        excerpt: document.excerpt,
        mdContent: document.mdContent,
        mdContentHash: document.mdContentHash,
        lastVisit: document.lastVisit,
        lastVisitDate: document.lastVisitDate
      }, `id = ${doc.id}`);

      console.debug('upsertDocument ::', sql, args, invalid);

      // Return nothing to indicate that nothing was inserted
      return;
    }

    const [sql, args, invalid] = SQLFormat.insert(`document`, {
        title: document.title,
        url: document.url,
        excerpt: document.excerpt,
        mdContent: document.mdContent,
        mdContentHash: document.mdContentHash,
        publicationDate: document.publicationDate,
        hostname: document.hostname,
        lastVisit: document.lastVisit,
        lastVisitDate: document.lastVisitDate,
        extractor: document.extractor,
        updatedAt: document.updatedAt || Date.now(),
        createdAt: document.createdAt || Date.now(),
    });
    
    console.debug('upsertDocument ::', sql, args, invalid);
    
    await this._db.exec(sql, args);
    
    // Add to the staging db as well
    await this._stagingDb.exec(sql, args);
    
    return this.findOne({ where: { url : document.url } });
  };

  // @ts-expect-error TS rightly thinks this is not initialized, however, the
  // rest of the code won't run until it is so I find it helpful to not
  // constantly have to null-check this
  private _db: DB;
  // @ts-expect-error
  private _stagingDb: DB;

  private _dbReady = false;
  // private turndown = new Turndown({
  //   headingStyle: "atx",
  //   codeBlockStyle: "fenced",
  //   hr: "---",
  // });

  constructor() {
    this.init()
      .then(() => {
        console.debug("DB ready");
      })
      .catch((err) => {
        console.error("Error initializing db", err);
        throw err;
      });
  }
  
  initDb = async ({ dbPath, sqlite, migrations }: { dbPath: string, sqlite: SQLite3, migrations: string[] }) => {
      const db = await sqlite.open(dbPath);

      console.debug(`db opened: :: ${dbPath}`);

      // Make sure migration table exists
      await db.exec(
        `CREATE TABLE IF NOT EXISTS internal_migrations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          sql TEXT UNIQUE NOT NULL,
          date TEXT
        );`
      );
      
      // Run migrations
      console.debug("migrations :: start");
      await migrate({ migrations, db });
      console.debug("migrations :: complete", migrations.length);
      
      return db;
  };

  private init = async () => {
    try {
      const sqlite = await initWasm(() => wasmUrl);
      console.debug("sqlite wasm loaded ::", wasmUrl);
      this._db = await this.initDb({ dbPath: "fttf_20231102.sqlite", sqlite, migrations: [
        ...migrations,
        ...ftsMigrations,
      ] });
      this._stagingDb = await this.initDb({ dbPath: "fttf_20231102.bak.sqlite", sqlite, migrations });
    this._dbReady = true;
    } catch (err) {
      console.error("Error running migrations", err);
      this.error = err
      throw err;
    }
  };

  /**
   * A template literal to make querying easier. Will forward ot execO once args are formatted.
   */
   sql = async <T extends {} = {}>(strings: TemplateStringsArray, ...values: any[]) => {
     const [str, args] = SQLFormat.format(strings, ...values);
     console.debug('sql ::', str, args)
     return this._db.execO<T>(str, args);
   };

  findOne = async ({ where }): Promise<DetailRow | null> => {
    return this.findOneRaw<DetailRow>(`SELECT * FROM "document" WHERE url = ? LIMIT 1`, [
      where.url,
    ]);
  };

  private findOneRaw = async <T extends {} = {}>(sql: string, args?: ObjectArray): Promise<T | null> => {
    const xs = await this._db.execO<T>(sql, args);

    if (xs.length > 1) {
      console.warn("findOne returned more than one result. Returning first result.");
    }

    if (xs.length === 0) {
      return null;
    }

    return xs[0];
  };
}
