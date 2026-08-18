using System.Text.Json;
using MEditService.Core.Queries;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Session;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Core.Ledger;

/// <summary>
/// Converts a live <see cref="IMajorRecord"/> (e.g. one <see cref="Serialization.RecordTextCodec"/>
/// just deserialized from ledger text at an earlier commit) into the same wire-shaped
/// <c>Dictionary&lt;string, JsonElement&gt;</c> a <c>PendingChangeUpsert</c> expects — what
/// <c>RecordReverter</c> needs to feed a reverted record's field values back through the normal
/// staging path (#371 AC3).
///
/// <b>Deliberately not a new native-value→JSON mapper.</b> <see cref="Schema.ColumnSpec.Extract"/>
/// (native-value reader) and <see cref="Schema.ColumnSpec.Apply"/> (JSON→native writer) are two legs
/// of a triangle; a hand-written third leg here would have to independently stay bit-for-bit
/// consistent with what <c>Apply</c> expects back, forever, across every field family (enum,
/// bitmask, FormKey, array, struct) — the exact class of silent divergence a revert must never
/// risk (orchestrator ruling, #371 Q1). Instead this reuses the real read path verbatim: the record
/// is added to a throwaway, single-record <see cref="IMod"/> (<see cref="RecordTableSchema.AddExisting"/>,
/// already exercised by <c>PluginWriter</c>'s renumber path) and indexed into a throwaway
/// <see cref="IRecordRepository"/> (<see cref="IRecordRepositoryFactory"/> — the same in-memory-DuckDB
/// construction every real session read already goes through), then read back out via
/// <see cref="IRecordRepository.GetRecord"/> — the very code every other record read in this
/// service uses. The conversion cannot drift from what a normal read produces because it *is* a
/// normal read; the scratch mod/repository are torn down (mod is never persisted; repository is
/// disposed) whether this succeeds or throws.
/// </summary>
public sealed class LedgerRecordFieldReader(IRecordRepositoryFactory repositoryFactory)
{
    public Dictionary<string, JsonElement> ReadFields(
        IMajorRecord record, RecordTableSchema schema, string pluginFileName, GameRelease release)
    {
        if (schema.AddExisting == null)
        {
            throw new InvalidOperationException(
                $"'{schema.TableName}' has no AddExisting delegate — cannot read it through the scratch-index round trip.");
        }

        // ModFactory.Activator, not `new Fallout4Mod(...)`: the same game-agnostic empty-mod
        // constructor SessionManager.CreatePlugin already uses — this class must not lock to one
        // game (root CLAUDE.md). Never written to disk; discarded once the scratch repository has
        // indexed it.
        var scratchMod = ModFactory.Activator(ModKey.FromFileName(pluginFileName), release);
        schema.AddExisting(scratchMod, record);

        using var scratchRepository = repositoryFactory.Create(release);
        scratchRepository.Index(scratchMod, loadOrderIndex: 0, participates: true, origin: PluginOrigin.DataDirectory);

        var detail = scratchRepository.GetRecord(
            schema.TableName, record.FormKey.ToString(), pluginFileName, PluginOrigin.DataDirectory, winnerOnly: false)
            ?? throw new InvalidOperationException(
                $"Scratch-index round trip produced no row for '{record.FormKey}' ('{schema.TableName}').");

        return detail.Fields.ToDictionary(fv => fv.Metadata.Name, fv => JsonSerializer.SerializeToElement(fv.Value));
    }
}
