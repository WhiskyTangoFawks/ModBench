using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.PluginAdapter;
using MEditService.TestSupport;
using Microsoft.Extensions.DependencyInjection;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Http.Tests.TestSupport;

/// <summary>Parks the index's read of every plugin's documents until released, so the index is
/// still reconciling.</summary>
internal sealed class ParkedPluginAdapter() : DelegatingPluginAdapter(TestAdapters.Mutagen())
{
    private readonly TaskCompletionSource _released = new(TaskCreationOptions.RunContinuationsAsynchronously);

    public override IPluginDocuments OpenDocuments(
        ModPath modPath, GameRelease gameRelease, IReadOnlyDictionary<string, RecordTableSchema> schemas,
        PluginStrings? strings = null)
    {
        // Bounded so a test that fails before releasing still lets its host stop.
        _released.Task.Wait(TimeSpan.FromSeconds(30));
        return base.OpenDocuments(modPath, gameRelease, schemas, strings);
    }

    internal void Release() => _released.TrySetResult();

    internal void Replace(IServiceCollection services) => services.AddSingleton<IPluginAdapter>(this);
}
