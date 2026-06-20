# TD-004 — Understand and eliminate silent catch blocks in SchemaReflector

## The suppressions

Three (now four) locations in `SchemaReflector.cs` catch all exceptions silently and return `null`. All carry a `// Stryker disable once Block:` comment because the catch body is never exercised by unit tests — only by `RealGameLoadTests` loading actual Fallout4.esm data:

| Location | Method | What it wraps |
|----------|--------|---------------|
| `GetSubFieldInfo` line ~415 | inline `Getter()` lambda | `prop.GetValue(obj)` on a sub-field |
| `GetColumnInfo` line ~555 | TranslatedString extractor | `TryGet(r, prop)` + `.String` access |
| `GetColumnInfo` line ~598 | List extractor | `TryGet(r, prop)` + `SerializeListItems(...)` |
| `TryGet` line ~705 | `TryGet` helper | `prop.GetValue(record)` on a top-level column |

The line-555 and line-598 catches wrap compound operations (property access plus further processing), so their catch body may be firing for either the `prop.GetValue` step OR the subsequent operation. The `TryGet` catch at line 705 isolates just the property access.

## What we know

- **Mutagen's nullability contract**: Optional Bethesda subrecords are represented as nullable properties (`T?`). The overlay implementation is supposed to return `null` when a subrecord is absent — not throw. So "optional field not present" is not the expected cause.
- **The catches do fire in practice**: Stryker's `perTest` coverage analysis confirmed the `TryGet` Block mutant is *covered* (the catch body is entered) by `RealGameLoadTests.PostSessionLoad_VanillaPlugins_*`. This means exceptions occur during real Fallout4.esm indexing.
- **Frequency is unknown**: Coverage tools record *whether* a line was hit, not how many times. Could be 1 exception per session load or 10,000.
- **Why it was silenced**: The original justification was "avoid log noise per-call during indexing." This was carried over from the TranslatedString/List extractors to `TryGet` without verifying frequency.

## Hypotheses for what is actually throwing

1. **Interface property mismatch**: `SchemaReflector.BuildSchema` calls `GetAllInterfaceProperties(getterType)` and then `GetColumnInfo` for every property on the full interface hierarchy. Some interfaces declare properties that the concrete overlay type implements as `throw new NotImplementedException()` or similar — particularly in Mutagen's generated code where partial implementations exist for abstract record variants.
2. **Subrecord parse error on malformed data**: If a plugin's binary data for a field is unexpected (wrong length, wrong type byte), the overlay parser throws during the first access. This would be a genuine exceptional condition, not a design smell.
3. **Nullable value type boxing edge case**: `Nullable<T>` properties accessed via reflection behave differently from direct access — `GetValue()` returns `null` for an unset `T?`, but some Mutagen overlay implementations may not handle the reflection path correctly.

## Investigation path

1. **Add temporary `LogDebug` to `TryGet`**:
   ```csharp
   catch (Exception ex)
   {
       _logger.LogDebug(ex, "TryGet: {Type}.{Prop} threw", record.GetType().Name, prop.Name);
       return null;
   }
   ```
   Run a session load with `"Logging": { "LogLevel": { "Default": "Debug" } }` and inspect `%LOCALAPPDATA%/mEdit/logs/`. This reveals exactly which record types and property names throw, and approximately how often.

2. **Check if the throwing properties are reachable**: Once the property names are known, check whether `GetColumnInfo` returns `null` for them (i.e., they were filtered out before `TryGet` is ever called in the extractor). If they're filtered, the catch is dead code on those paths. If they're not filtered, understand why a column was created for an unextractable property.

3. **Check for `NotImplementedException` in Mutagen generated code**:
   ```bash
   grep -rn "throw new NotImplementedException\|throw new InvalidOperationException" \
     Mutagen/Mutagen.Bethesda.Fallout4/Records/ --include="*Generated*" | head -20
   ```
   If any appear on properties that `GetColumnInfo` would walk, those are the culprits for hypothesis 1.

4. **Scope the fix to the actual cause**: If it's hypothesis 1 (interface stubs that always throw), the fix is to skip those properties in `BuildSchema` — filter them out before building extractors. If it's hypothesis 2 (malformed data), the current catch is correct but should be `catch (Exception ex)` with a `LogDebug`. If it's hypothesis 3 (reflection + nullable boxing), the fix is a specific null check before the cast.

## Acceptance criteria

- The four silent `catch { return null; }` blocks are replaced with either:
  - Targeted catches (`catch (NotImplementedException)`, etc.) with a `LogDebug` line, or
  - Eliminated entirely by fixing the upstream cause (skipping unimplementable properties)
- Stryker Block mutants at those locations are killed by real tests, not suppressed
- Frequency confirmed to be negligible (< ~10 per session load) or the design is revised if it isn't
