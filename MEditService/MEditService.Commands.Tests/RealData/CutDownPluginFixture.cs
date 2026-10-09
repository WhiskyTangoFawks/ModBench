using System.Text;
using MEditService.Codec.Serialization;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.SourceAdapter;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;
using Noggog.WorkEngine;

namespace MEditService.Commands.Tests.RealData;

/// <summary>The committed cut-down Fallout 4 plugin: real game data without the 316 MB master, so
/// the fixture is hermetic. Regenerate with the Index box's own generator when the schema or
/// curation changes.</summary>
public static class CutDownPluginFixture
{
    public const string PluginFileName = "mEditTestSubset.esm";

    public static string PluginPath =>
        Path.Combine(AppContext.BaseDirectory, "TestData", PluginFileName);

    public static readonly PluginAddress Plugin = new(PluginFileName, PluginOrigin.DataDirectory);

    /// <summary>The plugin and the tree Track makes of it, in <paramref name="modFolder"/>.</summary>
    internal static void TrackedInto(string modFolder) =>
        TrackedTemplates.CopyInto(modFolder, PluginFileName, template =>
        {
            File.Copy(PluginPath, Path.Combine(template, PluginFileName));
            TrackedTemplates.TrackAlone(template, PluginFileName);
        });

    /// <summary>Every document of the plugin's tree, keyed by FormKey.</summary>
    public static Dictionary<string, byte[]> ReadSourceTree(string modFolder) =>
        DocumentsOf(TrackedTree.Repository(modFolder, Plugin));

    private static Dictionary<string, byte[]> DocumentsOf(SourceRepository repository) =>
        TreeDocuments.Of(repository, Plugin).ToDictionary(document => document.FormKey, document => Encoding.UTF8.GetBytes(document.Body));

    // The library's whole-mod writer alone, not Track's own door: identical production code on
    // both sides would agree with itself about any file Track added.
    public static Dictionary<string, byte[]> DeriveSourceTreeFromBinary(string pluginPath)
    {
        // ImportSetter, not ImportGetter: a binary overlay reports some derived fields differently from a
        // fully materialized parse, so deriving through one would compare the tracked tree against a
        // differently parsed mod and call the difference a compile failure.
        var mod = ModFactory.ImportSetter(new ModPath(ModKey.FromFileName(PluginFileName), pluginPath), GameRelease.Fallout4);

        using var scratch = new ScratchDirectory("medit-compile-derived-");
        var root = Path.Combine(scratch, PluginSourceRoot.For(PluginFileName));
        Directory.CreateDirectory(root);
        RecordTextCodecGeneratorSeed
            .SerializeWholeMod((IFallout4ModGetter)mod, root, InlineWorkDropoff.Instance, CancellationToken.None)
            .GetAwaiter().GetResult();
        File.Move(
            Path.Combine(root, "RecordData.json"),
            Path.Combine(scratch, PluginSourceRoot.HeaderDocument(PluginFileName)));

        return DocumentsOf(SourceRepository.Over(TestMod.Of(Plugin, scratch), GameRelease.Fallout4))
            .ToDictionary(document => document.Key, document => StripCarriageReturns(document.Value));
    }

    // Production strips carriage returns when it writes a tree (PluginTrees), but that helper is
    // internal to PluginAdapter with no grant to this project, so the derived side is stripped
    // here the same way to compare bytes.
    private static byte[] StripCarriageReturns(byte[] bytes) => [.. bytes.Where(b => b != (byte)'\r')];
}
