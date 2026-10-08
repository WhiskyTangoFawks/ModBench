using System.Globalization;
using System.IO.Compression;
using System.Text;

namespace MEditService.TestSupport;

public sealed record StaleHeaderPlugin(string FileName, byte[] Bytes, uint StoredNextObjectId, uint StoredNumRecords)
{
    public string WriteInto(string directory)
    {
        var path = Path.Combine(directory, FileName);
        File.WriteAllBytes(path, Bytes);
        return path;
    }
}

/// <summary>Plugins whose stored HEDR disagrees with their content, three shapes a rewrite must carry through.</summary>
public static class StaleHeaderPlugins
{
    public const string SettingsFileName = "Pip Boy Sorting Settings.esp";
    public const string SierraFileName = "RecruitDog.esl";
    public const string HitechFileName = "Hitech Bins to Guild.esp";

    private const CompressionLevel LevelMutagenDoesNotWrite = CompressionLevel.Fastest;

    private static readonly byte[] Padding = Encoding.ASCII.GetBytes(
        string.Concat(Enumerable.Range(0, 400).Select(i => (i * 7919 % 97).ToString(CultureInfo.InvariantCulture))) + "\0");

    public static IReadOnlyList<StaleHeaderPlugin> All => [Settings, Sierra, Hitech];

    public static StaleHeaderPlugin Named(string fileName) => All.Single(p => p.FileName == fileName);

    /// <summary>Several masters and a few plain records.</summary>
    public static StaleHeaderPlugin Settings
    {
        get
        {
            string[] masters = ["Fallout4.esm", "DLCRobot.esm", "DLCworkshop01.esm"];
            byte[][] records = [.. Enumerable.Range(0, 4).Select(i => Misc(masters, 0x800 + (uint)i, $"SortingSettings{i}"))];
            return Build(SettingsFileName, nextObjectId: 2, numRecords: 16, light: false, masters, [RawPlugin.Group("MISC", records)]);
        }
    }

    /// <summary>A light plugin whose next object id lies beyond the light range, with records deflated at a level Mutagen does not write.</summary>
    public static StaleHeaderPlugin Sierra
    {
        get
        {
            string[] masters = ["Fallout4.esm"];
            var deflated = DeflatedMiscs(masters, "DogRecruit");
            return Build(SierraFileName, nextObjectId: 17098, numRecords: 148, light: true, masters, [RawPlugin.Group("MISC", deflated)]);
        }
    }

    /// <summary>Records deflated at a level Mutagen does not write, and a worldspace and an interior cell each under their group hierarchy.</summary>
    public static StaleHeaderPlugin Hitech
    {
        get
        {
            string[] masters = ["Fallout4.esm"];
            var deflated = DeflatedMiscs(masters, "BinSkin");
            var world = Id(masters, 0x810);
            return Build(HitechFileName, nextObjectId: 43, numRecords: 150, light: false, masters,
                [
                    RawPlugin.Group("MISC", deflated),
                    RawPlugin.Group("WRLD",
                        RawPlugin.Record("WRLD", world, EditorId("BinWorld")),
                        RawPlugin.Group(BitConverter.GetBytes(world), 1,
                            RawPlugin.Record("CELL", Id(masters, 0x811), EditorId("BinWorldCell")))),
                    RawPlugin.Group("CELL",
                        RawPlugin.Group(new byte[4], 2,
                            RawPlugin.Group(new byte[4], 3,
                                RawPlugin.Record("CELL", Id(masters, 0x812), EditorId("BinInterior"))))),
                ]);
        }
    }

    private static StaleHeaderPlugin Build(
        string fileName, uint nextObjectId, uint numRecords, bool light, string[] masters, byte[][] groups) =>
        new(fileName, RawPlugin.Plugin(RawPlugin.Tes4(nextObjectId, numRecords, light, masters), groups), nextObjectId, numRecords);

    private static byte[][] DeflatedMiscs(string[] masters, string editorIdPrefix) =>
        [.. Enumerable.Range(0, 3).Select(i => DeflatedMisc(masters, 0x800 + (uint)i, $"{editorIdPrefix}{i}"))];

    private static uint Id(string[] masters, uint objectId) => ((uint)masters.Length << 24) | objectId;

    private static byte[] EditorId(string editorId) => RawPlugin.Subrecord("EDID", Encoding.ASCII.GetBytes(editorId + "\0"));

    private static byte[] Misc(string[] masters, uint objectId, string editorId) =>
        RawPlugin.Record("MISC", Id(masters, objectId), EditorId(editorId));

    private static byte[] DeflatedMisc(string[] masters, uint objectId, string editorId) =>
        RawPlugin.DeflatedRecord("MISC", Id(masters, objectId), LevelMutagenDoesNotWrite, EditorId(editorId), RawPlugin.Subrecord("FULL", Padding));
}
