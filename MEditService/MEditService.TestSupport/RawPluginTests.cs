using System.Buffers.Binary;
using System.IO.Compression;
using System.Text;
using MEditService.Codec.Schema;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.TestSupport;

public class RawPluginTests
{
    private static byte[] Edid(string editorId) => RawPlugin.Subrecord("EDID", Encoding.ASCII.GetBytes(editorId + "\0"));

    [Fact]
    public void Subrecord_WritesSignatureLengthAndPayload()
    {
        var bytes = RawPlugin.Subrecord("DATA", [1, 2, 3]);

        Assert.Equal("DATA"u8.ToArray().Concat(new byte[] { 3, 0, 1, 2, 3 }), bytes);
    }

    [Fact]
    public void Record_WritesTheCallersFlagsFormVersionAndASizeOfItsSubrecords()
    {
        var bytes = RawPlugin.Record("MISC", 0x00ABCDEF, 0x20, 44, Edid("A"), Edid("B"));

        Assert.Equal("MISC", Encoding.ASCII.GetString(bytes, 0, 4));
        Assert.Equal(2u * 8, BinaryPrimitives.ReadUInt32LittleEndian(bytes.AsSpan(4)));
        Assert.Equal(0x20u, BinaryPrimitives.ReadUInt32LittleEndian(bytes.AsSpan(8)));
        Assert.Equal(0x00ABCDEFu, BinaryPrimitives.ReadUInt32LittleEndian(bytes.AsSpan(12)));
        Assert.Equal(44, BinaryPrimitives.ReadUInt16LittleEndian(bytes.AsSpan(20)));
        Assert.Equal(24 + 16, bytes.Length);
    }

    [Theory]
    [InlineData(CompressionLevel.Fastest)]
    [InlineData(CompressionLevel.SmallestSize)]
    public void DeflatedRecord_HoldsTheInflatedLengthThenAZlibStreamOfTheSubrecords(CompressionLevel level)
    {
        var subrecord = RawPlugin.Subrecord("DATA", new byte[200]);

        var bytes = RawPlugin.DeflatedRecord("MISC", 1, level, subrecord);

        Assert.Equal((uint)CompressedFlag.Bit, BinaryPrimitives.ReadUInt32LittleEndian(bytes.AsSpan(8)));
        Assert.Equal((uint)subrecord.Length, BinaryPrimitives.ReadUInt32LittleEndian(bytes.AsSpan(24)));
        using var inflated = new ZLibStream(new MemoryStream(bytes, 28, bytes.Length - 28), CompressionMode.Decompress);
        using var result = new MemoryStream();
        inflated.CopyTo(result);
        Assert.Equal(subrecord, result.ToArray());
    }

    [Fact]
    public void DeflatedRecord_TwoLevels_WriteDifferentStreams()
    {
        var subrecord = RawPlugin.Subrecord("DATA", Enumerable.Range(0, 2000).Select(i => (byte)(i * 31 % 251)).ToArray());

        Assert.NotEqual(
            RawPlugin.DeflatedRecord("MISC", 1, CompressionLevel.Fastest, subrecord),
            RawPlugin.DeflatedRecord("MISC", 1, CompressionLevel.SmallestSize, subrecord));
    }

    [Fact]
    public void Group_SizeCoversItsHeaderAndEveryRecordInside()
    {
        var record = RawPlugin.Record("MISC", 1, Edid("A"));

        var bytes = RawPlugin.Group("MISC", record, record);

        Assert.Equal("GRUP", Encoding.ASCII.GetString(bytes, 0, 4));
        Assert.Equal((uint)bytes.Length, BinaryPrimitives.ReadUInt32LittleEndian(bytes.AsSpan(4)));
        Assert.Equal(24 + 2 * record.Length, bytes.Length);
        Assert.Equal("MISC", Encoding.ASCII.GetString(bytes, 8, 4));
    }

    [Fact]
    public void Group_NestedInAnother_CountsInTheOuterSize()
    {
        var inner = RawPlugin.Group([1, 0, 0, 0], 6, RawPlugin.Record("REFR", 2));

        var outer = RawPlugin.Group([1, 0, 0, 0], 1, inner);

        Assert.Equal((uint)outer.Length, BinaryPrimitives.ReadUInt32LittleEndian(outer.AsSpan(4)));
        Assert.Equal(1, BinaryPrimitives.ReadInt32LittleEndian(outer.AsSpan(12)));
        Assert.Equal(6, BinaryPrimitives.ReadInt32LittleEndian(outer.AsSpan(24 + 12)));
    }

    [Fact]
    public void Plugin_IsOpenedByMutagen_WithItsMastersRecordsAndLightFlag()
    {
        var plugin = RawPlugin.Plugin(
            RawPlugin.Tes4(nextObjectId: 0x801, numRecords: 1, light: true, masters: "Fallout4.esm"),
            RawPlugin.Group("MISC", RawPlugin.Record("MISC", 0x01000800, Edid("RawMisc"))));
        using var scratch = new ScratchDirectory("raw-plugin");
        var path = Path.Combine(scratch.Path, "Raw.esp");
        File.WriteAllBytes(path, plugin);

        using var mod = Fallout4Mod.CreateFromBinaryOverlay(new ModPath(ModKey.FromFileName("Raw.esp"), path), Fallout4Release.Fallout4);

        Assert.Equal(["Fallout4.esm"], mod.ModHeader.MasterReferences.Select(m => m.Master.FileName.String));
        Assert.True(mod.ModHeader.Flags.HasFlag(Fallout4ModHeader.HeaderFlag.Small));
        Assert.Equal(0x801u, mod.ModHeader.Stats.NextFormID);
        Assert.Equal("RawMisc", Assert.Single(mod.MiscItems).EditorID);
    }

    [Theory]
    [InlineData(false, 0u)]
    [InlineData(true, 0x200u)]
    public void Tes4_FlagsAreTheLightFlagAloneAndNeverTheMasterFlag(bool light, uint expected)
    {
        var bytes = RawPlugin.Tes4(light: light);

        Assert.Equal(expected, BinaryPrimitives.ReadUInt32LittleEndian(bytes.AsSpan(8)));
    }

    [Fact]
    public void Tes4_StatsAreTheCallersEvenWhenStale()
    {
        var bytes = RawPlugin.Tes4(nextObjectId: 0x1234, numRecords: 99);

        Assert.Equal(99u, BinaryPrimitives.ReadUInt32LittleEndian(bytes.AsSpan(24 + 6 + 4)));
        Assert.Equal(0x1234u, BinaryPrimitives.ReadUInt32LittleEndian(bytes.AsSpan(24 + 6 + 8)));
    }
}
