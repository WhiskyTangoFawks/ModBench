using MEditService.LoadOrder;
using MEditService.SourceAdapter;
using MEditService.TestSupport;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Commands.Tests.TestSupport;

/// <summary>Real plugins in load order, each in a mod folder of its own: a source plugin one answers from its
/// tree, a non-source plugin one from its file. Every plugin but Fallout4.esm masters it.</summary>
internal sealed class LoadOrderOfPlugins : TestInstance
{
    internal static readonly ModKey Fallout4Esm = ModKey.FromFileName("Fallout4.esm");

    internal static Fallout4Mod Plugin(string name, Action<Fallout4Mod> holds)
    {
        var mod = new Fallout4Mod(ModKey.FromFileName(name), Fallout4Release.Fallout4);
        if (mod.ModKey != Fallout4Esm) mod.ModHeader.MasterReferences.Add(new MasterReference { Master = Fallout4Esm });
        holds(mod);
        return mod;
    }

    internal void Load(params (Fallout4Mod Mod, bool SourcePlugin)[] plugins)
    {
        foreach (var (mod, sourcePlugin) in plugins) Add(mod, Origin(mod), sourcePlugin);
        Seal();
    }

    /// <summary>Plugins in load order, each from the origin given, for two mods that provide one filename.</summary>
    internal void Load(params (Fallout4Mod Mod, string Origin, bool SourcePlugin, Listing Listing)[] plugins)
    {
        foreach (var (mod, origin, sourcePlugin, listing) in plugins) Add(mod, origin, sourcePlugin, listing);
        Seal();
    }

    internal static PluginAddress Address(IModGetter mod) => new(mod.ModKey.FileName, Origin(mod));

    internal string Text(IModGetter mod, FormKey formKey) => SourceModTree.Body(FolderOf(mod), Address(mod), formKey.ToString());

    /// <summary>Replaces <paramref name="replaced"/> in a source plugin's document for <paramref name="formKey"/>.</summary>
    internal void Respell(IModGetter mod, FormKey formKey, string recordType, string replaced, string with)
    {
        var text = Text(mod, formKey);
        if (!text.Contains(replaced, StringComparison.Ordinal))
            throw new InvalidOperationException($"Expected {mod.ModKey}'s document for {formKey} to hold '{replaced}'.");
        var unreadable = text.Replace(replaced, with, StringComparison.Ordinal);
        RepositoryOf(Address(mod)).Require()
            .Put(Address(mod), new SourceDocument(formKey.ToString(), recordType, null, unreadable)).Wrote();
    }

    /// <summary>Writes a non-source plugin's file anew, for bytes Mutagen's writer would not produce.</summary>
    internal void Rewrite(IModGetter mod, Action<string> write) => write(Path.Combine(FolderOf(mod), mod.ModKey.FileName));

    private static string Origin(IModGetter mod) => mod.ModKey.Name + "Mod";

    internal string FolderOf(IModGetter mod) => FolderOf(Origin(mod));

    /// <summary>The absolute path of the file of a source plugin's document for <paramref name="formKey"/>.</summary>
    internal string DocumentFileOf(IModGetter mod, FormKey formKey) =>
        Path.Combine(FolderOf(mod), SourceModTree.DocumentFile(FolderOf(mod), Address(mod), formKey.ToString()).Require());
}
