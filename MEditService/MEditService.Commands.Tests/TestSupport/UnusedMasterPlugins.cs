using System.IO.Compression;
using System.Text;
using MEditService.TestSupport;

namespace MEditService.Commands.Tests.TestSupport;

public sealed record UnusedMasterPlugin(string FileName, byte[] Bytes, IReadOnlyList<string> Masters)
    : GeneratedPlugin(FileName, Bytes);

/// <summary>Plugins whose header declares masters no record references, which Mutagen's writer would prune.</summary>
public static class UnusedMasterPlugins
{
    public const string RecordlessFileName = "Portrait Cache.esp";
    public const string OverridesFileName = "Rare Loot Overrides.esp";

    public static UnusedMasterPlugin Named(string fileName) => new[] { Recordless, Overrides }.Single(p => p.FileName == fileName);

    public static UnusedMasterPlugin Recordless => Build(RecordlessFileName, numRecords: 0, ["Fallout4.esm"]);

    public static UnusedMasterPlugin Overrides
    {
        get
        {
            string[] masters = ["Fallout4.esm", "DLCRobot.esm", "DLCworkshop01.esm", "DLCCoast.esm"];
            return Build(OverridesFileName, numRecords: 4, masters,
                RawPlugin.Group("MISC",
                    RawPlugin.Misc(0x0001F66B, "RareLootOverride0"),
                    RawPlugin.DeflatedRecord("MISC", 0x0001F66C, CompressionLevel.Fastest,
                        RawPlugin.EditorId("RareLootOverride1"), RawPlugin.Subrecord("FULL", Encoding.ASCII.GetBytes(new string('x', 300) + "\0"))),
                    RawPlugin.Misc(RawPlugin.NewRecordId(masters.Length, 0x800), "RareLootNew")));
        }
    }

    private static UnusedMasterPlugin Build(string fileName, uint numRecords, string[] masters, params byte[][] groups) =>
        new(fileName, RawPlugin.Plugin(RawPlugin.Tes4(0x801, numRecords, false, masters), groups), masters);
}
