using MEditService.Commands.Edits;
using MEditService.LoadOrder;
using MEditService.SourceAdapter;
using MEditService.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Commands.Tests.TestSupport;

/// <summary>Real plugins in load order, each in a mod folder of its own: a tracked one answers from its
/// tree, an untracked one from its file. Every plugin but Fallout4.esm masters it.</summary>
internal sealed class LoadOrderOfPlugins : IDisposable
{
    internal static readonly ModKey Fallout4Esm = ModKey.FromFileName("Fallout4.esm");

    private readonly ScratchDirectory _root = new("medit-load-order-");
    private LoadOrderHolder? _holder;

    internal static Fallout4Mod Plugin(string name, Action<Fallout4Mod> holds)
    {
        var mod = new Fallout4Mod(ModKey.FromFileName(name), Fallout4Release.Fallout4);
        if (mod.ModKey != Fallout4Esm) mod.ModHeader.MasterReferences.Add(new MasterReference { Master = Fallout4Esm });
        holds(mod);
        return mod;
    }

    internal void Load(params (Fallout4Mod Mod, bool Tracked)[] plugins)
    {
        var game = Directory.CreateDirectory(Path.Combine(_root, "game")).FullName;
        var entries = plugins.Select((p, slot) =>
        {
            var path = Path.Combine(Directory.CreateDirectory(FolderOf(p.Mod)).FullName, p.Mod.ModKey.FileName);
            p.Mod.WriteToBinary(path);
            return new LoadOrderEntry(p.Mod.ModKey.FileName, path, Origin(p.Mod), Slot: slot, Enabled: true, Winning: true);
        }).ToList();
        var loadOrder = SnapshotPlugins.Snapshot(game, _root, GameRelease.Fallout4, entries);
        foreach (var (mod, _) in plugins.Where(p => p.Tracked))
        {
            new TrackService(NullLogger<TrackService>.Instance, TestAdapters.Mutagen())
                .TrackModAsync(loadOrder, Origin(mod)).GetAwaiter().GetResult();
        }
        _holder = new LoadOrderHolder();
        _holder.Apply(loadOrder);
    }

    internal EditRecordHandler EditHandler => TestEditService.EditHandler(Holder);

    internal CopyRecordHandler CopyHandler => TestEditService.CopyHandler(Holder);

    internal static PluginAddress Address(IModGetter mod) => new(mod.ModKey.FileName, Origin(mod));

    internal string Text(IModGetter mod, FormKey formKey) => TrackedTree.Body(FolderOf(mod), Address(mod), formKey.ToString());

    /// <summary>Replaces <paramref name="replaced"/> in a tracked plugin's document for <paramref name="formKey"/>.</summary>
    internal void Respell(IModGetter mod, FormKey formKey, string recordType, string replaced, string with)
    {
        var text = Text(mod, formKey);
        if (!text.Contains(replaced, StringComparison.Ordinal))
            throw new InvalidOperationException($"Expected {mod.ModKey}'s document for {formKey} to hold '{replaced}'.");
        var unreadable = text.Replace(replaced, with, StringComparison.Ordinal);
        SourceRepository.Open(FolderOf(mod), GameRelease.Fallout4).Require()
            .Put(Address(mod), new SourceDocument(formKey.ToString(), recordType, null, unreadable));
    }

    /// <summary>Writes an untracked plugin's file anew, for bytes Mutagen's writer would not produce.</summary>
    internal void Rewrite(IModGetter mod, Action<string> write) => write(Path.Combine(FolderOf(mod), mod.ModKey.FileName));

    public void Dispose() => _root.Dispose();

    private LoadOrderHolder Holder => _holder ?? throw new InvalidOperationException("Load the plugins first.");

    private static string Origin(IModGetter mod) => mod.ModKey.Name + "Mod";

    internal string FolderOf(IModGetter mod) => Path.Combine(_root, "mods", Origin(mod));
}
