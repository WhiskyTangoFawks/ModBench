using System.IO.Compression;
using System.Text;

namespace MEditService.TestSupport;

public sealed record UnusedMasterPlugin(string FileName, byte[] Bytes, IReadOnlyList<string> Masters)
{
    public void WriteInto(string directory) => File.WriteAllBytes(Path.Combine(directory, FileName), Bytes);
}

/// <summary>Plugins whose header declares masters no record references, which Mutagen's writer would prune.</summary>
public static class UnusedMasterPlugins
{
    public const string RecordlessFileName = "Portrait Cache.esp";
    public const string OverridesFileName = "Rare Loot Overrides.esp";

    public static UnusedMasterPlugin Named(string fileName) => new[] { Recordless, Overrides }.Single(p => p.FileName == fileName);

    public static UnusedMasterPlugin Recordless => Build(RecordlessFileName, ["Fallout4.esm"]);

    public static UnusedMasterPlugin Overrides
    {
        get
        {
            string[] masters = ["Fallout4.esm", "DLCRobot.esm", "DLCworkshop01.esm", "DLCCoast.esm"];
            var newRecordId = ((uint)masters.Length << 24) | 0x800;
            return Build(OverridesFileName, masters,
                RawPlugin.Group("MISC",
                    Misc(0x0001F66B, "RareLootOverride0"),
                    RawPlugin.DeflatedRecord("MISC", 0x0001F66C, CompressionLevel.Fastest,
                        EditorId("RareLootOverride1"), RawPlugin.Subrecord("FULL", Encoding.ASCII.GetBytes(new string('x', 300) + "\0"))),
                    Misc(newRecordId, "RareLootNew")));
        }
    }

    private static UnusedMasterPlugin Build(string fileName, string[] masters, params byte[][] groups) =>
        new(fileName, RawPlugin.Plugin(RawPlugin.Tes4(0x801, (uint)groups.Length * 4, false, masters), groups), masters);

    private static byte[] EditorId(string editorId) => RawPlugin.Subrecord("EDID", Encoding.ASCII.GetBytes(editorId + "\0"));

    private static byte[] Misc(uint formId, string editorId) => RawPlugin.Record("MISC", formId, EditorId(editorId));
}
