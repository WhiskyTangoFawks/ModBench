using System.Buffers.Binary;
using System.Text;

namespace MEditService.TestSupport;

/// <summary>A region whose map-data RDAT is 6 bytes where Mutagen expects 8, so its parse desyncs and drops the subrecords after it.</summary>
public static class ShortRdatRegionPlugin
{
    public const string FileName = "Harbor Weather.esp";
    public const string Master = "Harbor Weather.esm";
    public const uint FormId = 0x01000800;
    public const string EditorId = "HarborRegion";

    private const uint WeatherData = 3;
    private const uint MapData = 4;
    private const uint SoundData = 7;
    private const int ShortLength = 6;
    private const int FullLength = 8;

    public static GeneratedPlugin Plugin => new(FileName,
        RawPlugin.Plugin(RawPlugin.Tes4(0x801, 1, false, Master),
            RawPlugin.Group("REGN",
                RawPlugin.Record("REGN", FormId,
                    RawPlugin.EditorId(EditorId),
                    RawPlugin.Subrecord("RCLR", new byte[4]),
                    Header(WeatherData, FullLength),
                    RawPlugin.Subrecord("RDWT", MasterWeather),
                    Header(MapData, ShortLength),
                    RawPlugin.Subrecord("RDMP", Encoding.ASCII.GetBytes("Harbor\0")),
                    RawPlugin.Subrecord("ANAM", new byte[4]),
                    Header(SoundData, FullLength),
                    RawPlugin.Subrecord("RDMO", new byte[4]),
                    RawPlugin.Subrecord("RDSA", new byte[12])))));

    private static byte[] MasterWeather
    {
        get
        {
            var entry = new byte[12];
            BinaryPrimitives.WriteUInt32LittleEndian(entry, 0x00000801);
            return entry;
        }
    }

    private static byte[] Header(uint dataType, int length)
    {
        var payload = new byte[length];
        BinaryPrimitives.WriteUInt32LittleEndian(payload, dataType);
        return RawPlugin.Subrecord("RDAT", payload);
    }
}
