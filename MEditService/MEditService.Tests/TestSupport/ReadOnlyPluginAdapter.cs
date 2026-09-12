using MEditService.Core.PluginAdapter;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Serialization;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.TestSupport;

/// <summary>A stand-in for the read verb alone, throwing on every write verb so a test that
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

    public IPluginRecordLookup OpenRecordLookup(
        ModPath modPath,
        GameRelease gameRelease,
        IReadOnlyDictionary<string, RecordTableSchema> schemas)
    {
        var loaded = OpenForRead(modPath, gameRelease);
        return ModDocuments.LookupOf(loaded.Getter, schemas, loaded);
    }

    public PluginFormIds ReadFormIds(ModPath modPath, GameRelease gameRelease)
    {
        using var loaded = OpenForRead(modPath, gameRelease);
        return OpenedPlugins.FormIdsIn(loaded.Getter, modPath.ModKey.FileName.String);
    }

    public virtual LinkAnswers LinkTargets(
        IReadOnlyList<ModPath> loadOrder,
        GameRelease gameRelease,
        IReadOnlyDictionary<string, RecordTableSchema> schemas,
        IReadOnlyCollection<string> formKeys) =>
        LoadOrderLinks.Targets(this, loadOrder, gameRelease, schemas, formKeys);

    public bool LinksTo(ModPath modPath, GameRelease gameRelease, FormKey target, FormKey? itself)
    {
        using var loaded = OpenForRead(modPath, gameRelease);
        return OpenedPlugins.LinksTo(loaded.Getter, modPath.ModKey.FileName.String, target, itself);
    }

    public IMod OpenForWrite(ModPath modPath, GameRelease gameRelease, PluginStrings? strings = null) =>
        throw new NotSupportedException($"{GetType().Name} answers reads only.");

    public IMod CreateEmpty(ModKey modKey, GameRelease gameRelease) =>
        throw new NotSupportedException($"{GetType().Name} answers reads only.");

    public Task CreateAndWriteAsync(
        ModKey modKey, string destinationPath, GameRelease gameRelease, bool smallMaster) =>
        throw new NotSupportedException($"{GetType().Name} answers reads only.");

    public Task WriteAsync(
        IMod plugin, string destinationPath, IReadOnlyList<string>? masterOrder = null, string? stringsFolder = null) =>
        throw new NotSupportedException($"{GetType().Name} answers reads only.");
}
