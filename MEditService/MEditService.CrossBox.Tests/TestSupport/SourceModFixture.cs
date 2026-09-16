using MEditService.Commands;
using MEditService.Commands.Edits;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.SourceRepo;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.TestSupport;

/// <summary>A mod folder holding whatever record shape a suite needs, and the write service over
/// it: the caller fills the plugin, this writes, registers and tracks it. No index and no store
/// (ADR-0015 invariant 5).</summary>
internal sealed class SourceModFixture : IDisposable
{
    private readonly string _instanceRoot;

    public string ModFolder { get; }
    internal string GameDirectory { get; }
    internal PluginCopyKey Plugin { get; }
    internal LoadOrderSnapshot LoadOrder { get; }
    internal EditRecordHandler EditHandler { get; }
    internal RenumberRecordHandler RenumberHandler { get; }

    private SourceModFixture(string pluginName, string origin, Action<Fallout4Mod> build)
    {
        var holder = new LoadOrderHolder();
        Plugin = new PluginCopyKey(pluginName, origin);
        _instanceRoot = Directory.CreateTempSubdirectory("medit-source-mod-").FullName;
        GameDirectory = Directory.CreateDirectory(Path.Combine(_instanceRoot, "game")).FullName;
        var tracked = origin != PluginOrigin.DataDirectory;

        // The game's own Data folder is never a mod folder, and never a repository either.
        ModFolder = tracked
            ? Directory.CreateDirectory(Path.Combine(_instanceRoot, "mods", origin)).FullName
            : GameDirectory;

        var pluginPath = Path.Combine(ModFolder, pluginName);
        var mod = new Fallout4Mod(ModKey.FromFileName(pluginName), Fallout4Release.Fallout4);
        build(mod);
        mod.WriteToBinary(pluginPath);

        LoadOrder = new LoadOrderSnapshot(
            GameDirectory, _instanceRoot, GameRelease.Fallout4,
            SnapshotCopies.Of([new LoadOrderEntry(pluginName, pluginPath, origin, Slot: 0, Enabled: true, Winning: true)]));

        if (tracked)
        {
            new TrackService(NullLogger<TrackService>.Instance, MutagenPluginAdapter.Instance)
                .TrackAsync(LoadOrder, [Plugin], origin, SourcePreset.Edits)
                .GetAwaiter().GetResult();
        }

        holder.Apply(LoadOrder);
        EditHandler = TestEditService.EditHandler(holder);
        RenumberHandler = TestEditService.RenumberHandler(holder);
    }

    internal static SourceModFixture Tracked(string pluginName, string origin, Action<Fallout4Mod> build) =>
        new(pluginName, origin, build);

    /// <summary>A master in the game's Data folder holding one NPC: registered and loaded, with no
    /// mod folder at all, which is a different refusal from an untracked copy.</summary>
    internal static SourceModFixture VanillaMaster(out FormKey npc)
    {
        var formKey = FormKey.Null;
        var fixture = new SourceModFixture(
            "Vanilla.esm", PluginOrigin.DataDirectory, mod => formKey = mod.Npcs.AddNew("VanillaNpc").FormKey);
        npc = formKey;
        return fixture;
    }

    /// <summary>What the tree holds for a FormKey, read back through the same repository the write
    /// side wrote through — the whole read model this fixture has.</summary>
    internal string Body(FormKey formKey) =>
        (TrackedTree.Document(ModFolder, Plugin, formKey.ToString())
            ?? throw new InvalidOperationException($"Expected '{formKey}' to have a tracked source document.")).Body;

    public void Dispose()
    {
        try { Directory.Delete(_instanceRoot, recursive: true); }
        catch (IOException) { /* scratch directory, best effort */ }
        catch (UnauthorizedAccessException) { /* ditto */ }
    }
}
