using System.IO.Compression;

namespace MEditService.TestSupport;

/// <summary>A plugin whose deflated record Mutagen re-deflates and whose placed reference rotates by -0.0.</summary>
public static class NegativeZeroPlugin
{
    public const string FileName = "Rotation Settings.esp";

    private const CompressionLevel LevelMutagenDoesNotWrite = CompressionLevel.Fastest;

    public static GeneratedPlugin Plugin
    {
        get
        {
            var world = RawPlugin.NewRecordId(0, 0x800);
            var cell = RawPlugin.NewRecordId(0, 0x801);
            var placed = RawPlugin.NewRecordId(0, 0x802);
            var rotation = new[] { -0.0f, 0f, 4.9f };
            byte[] placement = [.. new byte[12], .. rotation.SelectMany(r => RawPlugin.U32(BitConverter.SingleToUInt32Bits(r)))];
            var bytes = RawPlugin.Plugin(
                RawPlugin.Tes4(nextObjectId: 0x803, numRecords: 5, light: false),
                RawPlugin.Group("MISC",
                    RawPlugin.DeflatedRecord("MISC", RawPlugin.NewRecordId(0, 0x803), LevelMutagenDoesNotWrite, RawPlugin.EditorId("RotationSetting"))),
                RawPlugin.Group("WRLD",
                    RawPlugin.Record("WRLD", world, RawPlugin.EditorId("RotationWorld")),
                    RawPlugin.Group(RawPlugin.U32(world), 1,
                        RawPlugin.Record("CELL", cell, RawPlugin.EditorId("RotationWorldCell")),
                        RawPlugin.Group(RawPlugin.U32(cell), 6,
                            RawPlugin.Group(RawPlugin.U32(cell), 8,
                                RawPlugin.Record("ACHR", placed, RawPlugin.Subrecord("NAME", RawPlugin.U32(world)), RawPlugin.Subrecord("DATA", placement)))))));
            return new GeneratedPlugin(FileName, bytes);
        }
    }
}
