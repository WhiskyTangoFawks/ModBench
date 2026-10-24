using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Commands.Tests.TestSupport;

/// <summary>A mod folder holding whatever record shape a suite needs, and the write service over
/// it: the caller fills the plugin, this writes, registers and inits it. No index and no store
/// (ADR-0015).</summary>
internal sealed class SourceModFixture : TestInstance
{
    public string ModFolder { get; }
    internal PluginAddress Plugin { get; }

    private SourceModFixture(string pluginName, string origin, bool compiledPlugin, Action<Fallout4Mod> build)
    {
        var mod = new Fallout4Mod(ModKey.FromFileName(pluginName), Fallout4Release.Fallout4);
        build(mod);
        Plugin = Add(mod, origin, compiledPlugin);
        ModFolder = FolderOf(origin);
    }

    internal static SourceModFixture CompiledPlugin(string pluginName, string origin, Action<Fallout4Mod> build) =>
        new(pluginName, origin, compiledPlugin: true, build);

    /// <summary>A master in the game's Data folder holding one NPC: registered and loaded, with no
    /// mod folder at all, which is a different refusal from a non-compiled plugin.</summary>
    internal static SourceModFixture VanillaMaster(out FormKey npc)
    {
        var formKey = FormKey.Null;
        var fixture = new SourceModFixture(
            "Vanilla.esm", PluginOrigin.DataDirectory, compiledPlugin: false, mod => formKey = mod.Npcs.AddNew("VanillaNpc").FormKey);
        npc = formKey;
        return fixture;
    }

    /// <summary>A stray plugin in Overwrite holding one NPC: registered and loaded, with no mod
    /// folder at all (ADR-0012).</summary>
    internal static SourceModFixture OverwriteStray(out FormKey npc)
    {
        var formKey = FormKey.Null;
        var fixture = new SourceModFixture(
            "Stray.esp", LoadOrderEntry.OverwriteOrigin, compiledPlugin: false, mod => formKey = mod.Npcs.AddNew("StrayNpc").FormKey);
        npc = formKey;
        return fixture;
    }

    /// <summary>What the tree holds for a FormKey, read back through the same repository the write
    /// side wrote through — the whole read model this fixture has.</summary>
    internal string Body(FormKey formKey) => SourceModTree.Body(ModFolder, Plugin, formKey.ToString());
}
