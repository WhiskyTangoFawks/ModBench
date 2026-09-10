using MEditService.Core.PluginAdapter;
using MEditService.Core.Schema;
using MEditService.Core.Serialization;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.TestSupport;

/// <summary>A stand-in for the read verb alone, throwing on the three write verbs so a test that
/// reaches one names itself rather than passing on a silent stub.</summary>
public abstract class ReadOnlyPluginAdapter : IPluginAdapter
{
    public abstract ILoadedMod OpenForRead(
        ModPath modPath, GameRelease gameRelease, PluginStrings? strings = null);

    public IPluginDocuments OpenDocuments(
        ModPath modPath,
        GameRelease gameRelease,
        IReadOnlyDictionary<string, RecordTableSchema> schemas,
        PluginStrings? strings = null)
    {
        var loaded = OpenForRead(modPath, gameRelease, strings);
        return ModDocuments.Of(loaded.Getter, schemas, loaded);
    }

    public IMod OpenForWrite(ModPath modPath, GameRelease gameRelease, PluginStrings? strings = null) =>
        throw new NotSupportedException($"{GetType().Name} answers reads only.");

    public IMod CreateEmpty(ModKey modKey, GameRelease gameRelease) =>
        throw new NotSupportedException($"{GetType().Name} answers reads only.");

    public Task WriteAsync(
        IMod plugin, string destinationPath, IReadOnlyList<string>? masterOrder = null, string? stringsFolder = null) =>
        throw new NotSupportedException($"{GetType().Name} answers reads only.");
}
