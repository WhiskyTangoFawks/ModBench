using System.Text;
using MEditService.TestSupport;

namespace MEditService.Commands.Tests.TestSupport;

/// <summary>A material swap below form version 112 whose two FNAM strings differ, which Mutagen refuses to read.</summary>
public static class MismatchedFnamPlugin
{
    public const string FileName = "Break Room Clipboards.esp";
    private const string FirstFnam = "materials";
    private const string SecondFnam = "";

    private const ushort FormVersionBeforeTreeFolder = 100;

    public static GeneratedPlugin Plugin => new(FileName, RawPlugin.Plugin(RawPlugin.Tes4(0x801, 2), MaterialSwap));

    /// <summary>The same plugin with a REGN whose RDAT is short, which the malformed-plugin scan diagnoses and a repair answers.</summary>
    public static GeneratedPlugin PluginWithAShortRegion => new(FileName,
        RawPlugin.Plugin(RawPlugin.Tes4(0x802, 4), MaterialSwap,
            RawPlugin.Group("REGN", RawPlugin.Record("REGN", 0x00000801, RawPlugin.EditorId("HarborRegion"), RawPlugin.Subrecord("RDAT", new byte[6])))));

    private static byte[] MaterialSwap =>
        RawPlugin.Group("MSWP",
            RawPlugin.Record("MSWP", 0x00000800, 0, FormVersionBeforeTreeFolder,
                RawPlugin.EditorId("BreakRoomClipboardSwap"),
                Text("BNAM", "Materials\\Clipboard\\Clean.BGSM"),
                Text("SNAM", "Materials\\Clipboard\\Worn.BGSM"),
                Text("FNAM", FirstFnam),
                Text("BNAM", "Materials\\Clipboard\\Paper.BGSM"),
                Text("SNAM", "Materials\\Clipboard\\Torn.BGSM"),
                Text("FNAM", SecondFnam)));

    private static byte[] Text(string signature, string value) => RawPlugin.Subrecord(signature, Encoding.ASCII.GetBytes(value + "\0"));
}
