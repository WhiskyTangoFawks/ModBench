using MEditService.Codec.Serialization;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.SourceAdapter;
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

    public static string SourceRootIn(string modFolder) =>
        Path.Combine(modFolder, SourceRepository.RootFor(PluginFileName));

    /// <summary>Every document of the plugin's tree, keyed by its path relative to the mod folder.</summary>
    public static Dictionary<string, byte[]> ReadSourceTree(string modFolder) =>
        Directory.EnumerateFiles(SourceRootIn(modFolder), "*.json", SearchOption.AllDirectories)
            .ToDictionary(f => Path.GetRelativePath(modFolder, f), File.ReadAllBytes);

    // The library's whole-mod writer alone, not TrackService's own door: identical production code on
    // both sides would agree with itself about any file Track added.
    public static Dictionary<string, byte[]> DeriveSourceTreeFromBinary(string pluginPath)
    {
        // ImportSetter, not ImportGetter: a binary overlay reports some derived fields differently from a
        // fully materialized parse, so deriving through one would compare the tracked tree against a
        // differently parsed mod and call the difference a compile failure.
        var mod = ModFactory.ImportSetter(new ModPath(ModKey.FromFileName(PluginFileName), pluginPath), GameRelease.Fallout4);

        var scratch = Directory.CreateTempSubdirectory("medit-compile-derived-").FullName;
        try
        {
            RecordTextCodecGeneratorSeed
                .SerializeWholeMod((IFallout4ModGetter)mod, scratch, InlineWorkDropoff.Instance, CancellationToken.None)
                .GetAwaiter().GetResult();

            return Directory.EnumerateFiles(scratch, "*.json", SearchOption.AllDirectories)
                .ToDictionary(
                    f => Path.Combine(SourceRepository.RootFor(PluginFileName), Path.GetRelativePath(scratch, f)),
                    f => StripCarriageReturns(File.ReadAllBytes(f)));
        }
        finally
        {
            TrackedTemplates.TryDelete(scratch);
        }
    }

    // Production strips carriage returns when it writes a tree (PluginTrees), but that helper is
    // internal to PluginAdapter with no grant to this project, so the derived side is stripped
    // here the same way to compare bytes.
    private static byte[] StripCarriageReturns(byte[] bytes) => [.. bytes.Where(b => b != (byte)'\r')];
}
