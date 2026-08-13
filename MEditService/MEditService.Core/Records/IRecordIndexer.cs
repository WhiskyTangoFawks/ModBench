using MEditService.Core.Session;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Core.Records;

public interface IRecordIndexer : IDisposable
{
    void Initialize(GameRelease release);

    // participates (#267 / ADR-0035): the plugins.txt `*` prefix. Defaults true so the many
    // existing single/enabled-plugin call sites are unaffected; UpdateWinners never marks a
    // non-participating plugin's row a winner, regardless of load_order_idx.
    //
    // origin (#271 / ADR-0036): the mod folder that provided this physical file, or a reserved
    // PluginOrigin value. Required (#275 — the contract step): a plugin is identified by
    // (origin, plugin) together in every table this indexes — see DuckDbRecordRepository — and no
    // caller gets to skip specifying which one this physical file is.
    void Index(IModGetter pluginMod, int loadOrderIndex, bool participates, string origin);

    /// <summary>
    /// Removes every trace of one indexed (origin, plugin) from the read model — records, header,
    /// lookup, references, VMAD, conditions and placement (#34 / ADR-0035). The inverse of
    /// <see cref="Index"/>, and the mechanism behind "hidden means absent" for a plugin the load
    /// order does not name: a hidden copy is not filtered out of query results, it is not there.
    /// No winner re-sweep is implied — only non-participating plugins are ever unindexed, and they
    /// were never eligible to win.
    /// </summary>
    void Unindex(string plugin, string origin);

    void UpdateWinners();

    /// <summary>
    /// Flips an already-indexed plugin's participation flag — SQL-only, no re-index (ADR-0035's
    /// live-mutation model). Winner state is stale until the next <see cref="UpdateWinners"/> sweep.
    /// </summary>
    void SetPluginParticipation(string plugin, bool participates, string origin);
}
