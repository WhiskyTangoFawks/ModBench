using MEditService.Commands.Edits;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.RepositoriesLib;
using MEditService.SourceAdapter;

namespace MEditService.Commands;

/// <summary>A Modbench script's records made into a generated patch plugin with no plugin source, through compile's checks
/// and write (scripts.md, Writing, stories 7 and 8).</summary>
public sealed class MakePatchPluginHandler
{
    private readonly LoadOrderHolder _holder;
    private readonly IPluginAdapter _adapter;
    private readonly ISourceAdapter _source;
    private readonly PatchRecords _records;
    private readonly TreeCompile _compile;
    private readonly HeldWrites _held;

    // Internal so only CommandHandlers.AddCommandHandlers builds one, like every other handler.
    internal MakePatchPluginHandler(
        LoadOrderHolder holder, IPluginAdapter adapter, ISourceAdapter source, PatchRecords records, TreeCompile compile, HeldWrites held) =>
        (_holder, _adapter, _source, _records, _compile, _held) = (holder, adapter, source, records, compile, held);

    /// <summary>The plugin goes where a create in <paramref name="origin"/> puts one, over no file and never as a compiled plugin.
    /// Refuses, writing nothing, as create and compile refuse, and for a record no plugin's copy says how to lay out.</summary>
    public async Task<Answer<PatchMade, PatchRefused>> Make(
        string origin, string name, IReadOnlyList<string>? flags, IReadOnlyList<GivenRecord> records, CancellationToken cancel = default)
    {
        if (_holder.Held is not { Snapshot: var loadOrder })
            return new PatchRefused.AsCreate(PluginCreateRefusal.NoLoadOrder, NoLoadOrderException.DefaultMessage);
        var release = loadOrder.GameRelease;
        if (!CreatePluginInModHandler.PlaceOf(loadOrder, origin, name).Holds(out var place, out var notPlaced)) return Refused(notPlaced);
        if (!CreatePluginHandler.HeaderOf(name, release, flags).Holds(out var header, out var notCreatable)) return Refused(notCreatable);

        var path = _adapter.PathOfEmpty(header.Key, place.Folder);
        var registered = new RegisteredPlugin(name, place.Name, path, new PluginProvider.FromMod(place.Name, place.Folder, place.SourceFolder), Line: null, PluginStrings.None);
        if (_source.SourceReads(registered))
        {
            return new PatchRefused.AsCreate(
                PluginCreateRefusal.CompiledPlugin,
                $"'{place.SourceFolder}' holds plugin source for {name}, and its next compile would overwrite the plugin, so {name} was not made.");
        }
        if (_adapter.HeldAt(path) is { } held) return new PatchRefused.AsCreate(PluginCreateRefusal.FileExists, FileAt(place, held, name));

        var plugin = new PluginAddress(name, place.Name);
        if (!_records.Laid(name, records, release, cancel).Holds(out var laid, out var unlaid)) return unlaid;
        if (!PluginTreeFiles.Made(name, _adapter.EmptyTree(header.Key, release, header.Flags), laid, release).Holds(out var tree, out var unmade))
            return Refused(TreeCompile.RecordsDoNotParse(plugin, unmade));

        var taken = false;
        var made = await _compile.CompileAsync(registered, tree, loadOrder, save =>
        {
            if (save.CommitOverNoFile()) return true;
            taken = true;
            return TreeCompile.NotWritten(plugin, FileAt(place, name, name));
        });
        if (taken) return new PatchRefused.AsCreate(PluginCreateRefusal.FileExists, FileAt(place, name, name));
        if (!made.Succeeded) return Refused(made);

        await _held.ReadBack([plugin], cancel);
        return new PatchMade(plugin, made.Diagnostics);
    }

    private static string FileAt(PluginPlace place, string held, string name) => $"{place.Folder} already holds {held}, so {name} was not made.";

    private static PatchRefused.AsCreate Refused(PluginCreateRefused refused) => new PatchRefused.AsCreate(refused.Refusal, refused.Message);

    private static PatchRefused.AsCompile Refused(PluginCompileOutcome refused) =>
        new PatchRefused.AsCompile(refused.Refusal, refused.RefusalReason ?? throw new InvalidOperationException("Expected a refused compile to carry the reason it was refused."));
}
