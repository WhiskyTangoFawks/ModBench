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
    // PluginOrigin value. Defaulted to PluginOrigin.DataDirectory so existing call sites (every one
    // predating #271, plus test fixtures that don't care) keep compiling unchanged; SessionManager
    // is the one production caller that threads a real origin. A plugin is now identified by
    // (origin, plugin) together in every table this indexes — see DuckDbRecordRepository.
    void Index(IModGetter pluginMod, int loadOrderIndex, bool participates = true, string origin = PluginOrigin.DataDirectory);
    void UpdateWinners();

    /// <summary>
    /// Flips an already-indexed plugin's participation flag — SQL-only, no re-index (ADR-0035's
    /// live-mutation model). Winner state is stale until the next <see cref="UpdateWinners"/> sweep.
    /// origin defaults for the same reason as <see cref="Index"/>.
    /// </summary>
    void SetPluginParticipation(string plugin, bool participates, string origin = PluginOrigin.DataDirectory);
}
