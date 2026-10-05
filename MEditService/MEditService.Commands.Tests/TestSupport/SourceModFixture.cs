using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Commands.Tests.TestSupport;

/// <summary>A mod folder holding whatever record shape a suite needs, and the write service over
/// it: the caller fills the plugin, this writes, registers and tracks it. No index and no store
/// (ADR-0015).</summary>
internal sealed class SourceModFixture : IDisposable
{
    private readonly string _instanceRoot;

    public string ModFolder { get; }
    internal string GameDirectory { get; }
    internal PluginAddress Plugin { get; }
    internal LoadOrderSnapshot LoadOrder { get; }
    internal EditRecordHandler EditHandler { get; }
    internal DeleteRecordHandler DeleteHandler { get; }

    private SourceModFixture(string pluginName, string origin, Action<Fallout4Mod> build)
    {
        var holder = new LoadOrderHolder();
        Plugin = new PluginAddress(pluginName, origin);
        _instanceRoot = Directory.CreateTempSubdirectory("medit-source-mod-").FullName;
        GameDirectory = Directory.CreateDirectory(Path.Combine(_instanceRoot, "game")).FullName;
        var tracked = new RegisteredPlugin(pluginName, origin, Path.Combine(_instanceRoot, pluginName)).Provider is PluginProvider.FromMod;

        // The game's own Data folder and Overwrite are never mod folders, and never a repository
        // either (ADR-0012).
        ModFolder = origin switch
        {
            PluginOrigin.DataDirectory => GameDirectory,
            PluginOrigin.Overwrite => Directory.CreateDirectory(Path.Combine(_instanceRoot, "overwrite")).FullName,
            _ => Directory.CreateDirectory(Path.Combine(_instanceRoot, "mods", origin)).FullName,
        };

        var pluginPath = Path.Combine(ModFolder, pluginName);
        var mod = new Fallout4Mod(ModKey.FromFileName(pluginName), Fallout4Release.Fallout4);
        build(mod);
        if (tracked) TrackedTemplates.WriteTracked(ModFolder, mod);
        else mod.WriteToBinary(pluginPath);

        LoadOrder = SnapshotPlugins.Snapshot(
            GameDirectory, _instanceRoot, GameRelease.Fallout4,
            [new LoadOrderEntry(pluginName, pluginPath, origin, Slot: 0, Enabled: true, Winning: true)]);

        holder.Apply(LoadOrder);
        EditHandler = TestEditService.EditHandler(holder);
        DeleteHandler = TestEditService.DeleteHandler(holder);
    }

    internal static SourceModFixture Tracked(string pluginName, string origin, Action<Fallout4Mod> build) =>
        new(pluginName, origin, build);

    /// <summary>A master in the game's Data folder holding one NPC: registered and loaded, with no
    /// mod folder at all, which is a different refusal from an untracked plugin.</summary>
    internal static SourceModFixture VanillaMaster(out FormKey npc)
    {
        var formKey = FormKey.Null;
        var fixture = new SourceModFixture(
            "Vanilla.esm", PluginOrigin.DataDirectory, mod => formKey = mod.Npcs.AddNew("VanillaNpc").FormKey);
        npc = formKey;
        return fixture;
    }

    /// <summary>A stray plugin in Overwrite holding one NPC: registered and loaded, with no mod
    /// folder at all (ADR-0012).</summary>
    internal static SourceModFixture OverwriteStray(out FormKey npc)
    {
        var formKey = FormKey.Null;
        var fixture = new SourceModFixture(
            "Stray.esp", PluginOrigin.Overwrite, mod => formKey = mod.Npcs.AddNew("StrayNpc").FormKey);
        npc = formKey;
        return fixture;
    }

    /// <summary>What the tree holds for a FormKey, read back through the same repository the write
    /// side wrote through — the whole read model this fixture has.</summary>
    internal string Body(FormKey formKey) => TrackedTree.Body(ModFolder, Plugin, formKey.ToString());

    public void Dispose()
    {
        try { Directory.Delete(_instanceRoot, recursive: true); }
        catch (IOException) { /* scratch directory, best effort */ }
        catch (UnauthorizedAccessException) { /* ditto */ }
    }
}
