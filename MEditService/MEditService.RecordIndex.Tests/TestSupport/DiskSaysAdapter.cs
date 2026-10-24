using System.Collections.Concurrent;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.RepositoriesLib;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.RecordIndex.Tests.TestSupport;

/// <summary>Real plugins, with the adapter saying a file has gone or changed while its bytes stay as
/// they are; every read of a gone file answers as a read of no file does.</summary>
internal sealed class DiskSaysAdapter(TimeProvider? clock = null)
    : DelegatingPluginAdapter(new MutagenPluginAdapter(clock ?? TimeProvider.System))
{
    private const string ChangedHash = "changed";

    private readonly ConcurrentDictionary<string, bool> _gone = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, bool> _changed = new(StringComparer.Ordinal);

    public void Gone(string pluginPath) => _gone[pluginPath] = true;

    public void Changed(string pluginPath) => _changed[pluginPath] = true;

    private bool IsGone(string pluginPath) => _gone.ContainsKey(pluginPath);

    public override bool Exists(string pluginPath) => !IsGone(pluginPath) && base.Exists(pluginPath);

    public override string? HashOf(string pluginPath)
    {
        if (IsGone(pluginPath)) return null;
        return _changed.ContainsKey(pluginPath) ? ChangedHash : base.HashOf(pluginPath);
    }

    public override Answer<FileClaim, PluginFailure> ClaimOf(string pluginPath, GameRelease gameRelease)
    {
        if (IsGone(pluginPath)) return PluginFailures.Inaccessible();
        return _changed.ContainsKey(pluginPath) && base.ClaimOf(pluginPath, gameRelease).Holds(out var claim, out _)
            ? PluginAnswer.Of(claim with { Hash = ChangedHash })
            : base.ClaimOf(pluginPath, gameRelease);
    }

    public override Answer<(PluginContent Content, PluginFailure? Unreachable), PluginFailure> ReadContent(
        ModPath modPath, LoadOrderSnapshot loadOrder, PluginStrings strings) =>
        IsGone(modPath.Path) ? PluginFailures.Inaccessible() : base.ReadContent(modPath, loadOrder, strings);

    public override Answer<IPluginDocuments, PluginFailure> OpenDocuments(
        ModPath modPath, LoadOrderSnapshot loadOrder, IReadOnlyDictionary<string, RecordTableSchema> schemas,
        PluginStrings strings) =>
        IsGone(modPath.Path) ? PluginFailures.Inaccessible() : base.OpenDocuments(modPath, loadOrder, schemas, strings);
}
