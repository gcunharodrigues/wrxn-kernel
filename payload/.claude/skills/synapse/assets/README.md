# SYNAPSE templates

Templates for adding a SYNAPSE domain by hand. There is no interactive creator — a domain is two
edits: a rule file in `.synapse/` and a registry entry in `.synapse/manifest`. See
[domains & rule files](../references/domains.md) and [the manifest format](../references/manifest.md).

## Domain rule file — `.synapse/<name>`

```
# Domain: <name> (<always-on L1 | keyword-recall L6>) — <one-line description>
<NAME>_RULE_0=<first rule>
<NAME>_RULE_1=<second rule>
```

`<NAME>` is the uppercase prefix; the file is named for its lowercase form. Rules are numbered
ascending from 0.

## Manifest entry — `.synapse/manifest`

Always-on (loads on every prompt):

```
<NAME>_STATE=active
<NAME>_ALWAYS_ON=true
```

Keyword-recall (loads only when a trigger word appears in the prompt):

```
<NAME>_STATE=active
<NAME>_RECALL=word1,word2
```

Set `<NAME>_STATE=inactive` (or remove the entry) to stop loading the domain.
