# Repository context

Source-bound engineering orientation. Review changed facts before refreshing hashes. This is reference data, not new authority.

```json context-projection
{
  "schema": "context-projection/v1",
  "projection": "ctx:4172e2ed",
  "scope": "parent",
  "product": "ferry",
  "repository": {
    "id": "ferry",
    "sources": [
      {
        "path": "CONTRIBUTING.md",
        "sha256": "63cc761bbcd7f889259c2f926c4dae0ba93134268272a3d566434662c90f289c"
      },
      {
        "path": "README.md",
        "sha256": "7c748206ec3fc9ff8dd895c97679227142963f66c2b70ada3dc2f672a364248a"
      },
      {
        "path": "package.json",
        "sha256": "83b4e8a5e80c583825dfa36e48df09023d3d32b4cebfd82232bee00f90d54c24"
      }
    ]
  },
  "revalidate_by": "2026-11-08",
  "gate": {
    "mode": "blocking"
  },
  "inaccessible": [],
  "gate_config": {
    "story_paths": [],
    "never_story": [],
    "never_pages": [],
    "locked_files": [],
    "blocking_products": [],
    "advisory_until": "2026-10-08",
    "doc_owners": [],
    "projections": [
      {
        "path": ".context/repository.md",
        "handle": "ctx:4172e2ed",
        "product": "ferry"
      }
    ]
  },
  "items": [
    {
      "handle": "ctx:f3a3c80d",
      "section": "map",
      "binding": false,
      "text": "Ferry is a local secrets broker: declared secrets enter an allowed child process environment, with output redaction and an audit trail. It has zero runtime dependencies and is not a sandbox.",
      "classes": [
        "orientation",
        "engineering"
      ],
      "source_paths": [
        "README.md"
      ]
    },
    {
      "handle": "ctx:ad8a12fd",
      "section": "map",
      "binding": false,
      "text": "src/index.ts is the public API; cli.ts owns commands; runner.ts wires child execution, redaction and audit; glob.ts matches positional argv; schema.ts validates configuration; backends/ owns secret resolution.",
      "classes": [
        "orientation",
        "engineering"
      ],
      "source_paths": [
        "CONTRIBUTING.md"
      ]
    },
    {
      "handle": "ctx:2ba952e9",
      "section": "claims",
      "binding": false,
      "text": "The package uses Node >=20 and pnpm10.30.2. pnpm build emits dist library and CLI artifacts; source exports and published exports differ through publishConfig.",
      "classes": [
        "orientation",
        "engineering"
      ],
      "source_paths": [
        "package.json"
      ]
    },
    {
      "handle": "ctx:622d5542",
      "section": "decisions",
      "binding": true,
      "text": "Start short-lived changes from origin/dev and PR to dev. main is the production/release branch, reached through a promotion PR; see RELEASING.md for release mechanics.",
      "classes": [
        "orientation",
        "engineering"
      ],
      "source_paths": [
        "CONTRIBUTING.md"
      ]
    },
    {
      "handle": "ctx:3192c9fc",
      "section": "decisions",
      "binding": true,
      "text": "The child inherits undeclared ambient environment values by default and those values are not redacted. --clean-env or cleanEnv:true forwards a minimal base environment plus injected secrets.",
      "classes": [
        "orientation",
        "engineering"
      ],
      "source_paths": [
        "README.md"
      ]
    },
    {
      "handle": "ctx:58426648",
      "section": "decisions",
      "binding": true,
      "text": "Configuration is trusted executable code. Allowed commands can misuse secrets they receive; Ferry does not defend against a compromised host. Do not confuse transcript redaction with complete isolation.",
      "classes": [
        "orientation",
        "engineering"
      ],
      "source_paths": [
        "README.md"
      ]
    },
    {
      "handle": "ctx:ce112f4f",
      "section": "decisions",
      "binding": true,
      "text": "Changes near runner, redactor or audit require tests proving secret values do not escape. Keep runtime dependencies at zero; report vulnerabilities privately through SECURITY.md.",
      "classes": [
        "orientation",
        "engineering"
      ],
      "source_paths": [
        "CONTRIBUTING.md"
      ]
    },
    {
      "handle": "ctx:f1777bff",
      "section": "claims",
      "binding": false,
      "text": "Run pnpm typecheck, pnpm test and pnpm lint:publish; the last builds and checks package exports. Hosted service, rotation, cloud backends, team sync and GUI are outside the README v0.1 boundary.",
      "classes": [
        "orientation",
        "engineering"
      ],
      "source_paths": [
        "package.json",
        "README.md"
      ]
    }
  ]
}
```
