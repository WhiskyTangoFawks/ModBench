using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Core.Records;

public interface IRecordIndexer : IDisposable
{
    void Initialize(GameRelease release);
    void Index(IModGetter pluginMod, int loadOrderIndex);
    void UpdateWinners();
}
