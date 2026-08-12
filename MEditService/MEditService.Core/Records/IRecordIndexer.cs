using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Core.Records;

public interface IRecordIndexer : IDisposable
{
    void Initialize(GameRelease release);

    // participates (#267 / ADR-0035): the plugins.txt `*` prefix. Defaults true so the many
    // existing single/enabled-plugin call sites are unaffected; UpdateWinners never marks a
    // non-participating plugin's row a winner, regardless of load_order_idx.
    void Index(IModGetter pluginMod, int loadOrderIndex, bool participates = true);
    void UpdateWinners();

    /// <summary>
    /// Flips an already-indexed plugin's participation flag — SQL-only, no re-index (ADR-0035's
    /// live-mutation model). Winner state is stale until the next <see cref="UpdateWinners"/> sweep.
    /// </summary>
    void SetPluginParticipation(string plugin, bool participates);
}
