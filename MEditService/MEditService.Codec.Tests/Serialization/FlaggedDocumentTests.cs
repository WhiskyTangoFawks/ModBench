using MEditService.Codec.Serialization;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Codec.Tests.Serialization;

public sealed class FlaggedDocumentTests
{
    [Fact]
    public void AFlaggedRecord_KeepsTheMembersReadBeforeAnyField_ThenItsDiagnoses_ThenEverySubrecordAsItsBytes()
    {
        var region = new Region(new FormKey(ModKey.FromFileName("Test.esp"), 0x800), Fallout4Release.Fallout4)
        {
            EditorID = "Harbor",
            Map = new RegionMap { Name = "Harbor" },
        };

        var flagged = FlaggedDocument.For(
            RecordTextCodec.SerializeToText(region, GameRelease.Fallout4),
            ["REGN 00000800 (Harbor) — fixed-size-subrecord-short: RDAT is 6 bytes"],
            [("EDID", "Harbor\0"u8.ToArray()), ("RDAT", new byte[6]), ("RDAT", Array.Empty<byte>())]);

        Assert.Equal(
            """
            {
              "FormKey": "000800:Test.esp",
              "EditorID": "Harbor",
              "Diagnoses": [
                "REGN 00000800 (Harbor) — fixed-size-subrecord-short: RDAT is 6 bytes"
              ],
              "Subrecords": [
                {
                  "EDID": "0x486172626F7200"
                },
                {
                  "RDAT": "0x000000000000"
                },
                {
                  "RDAT": "[]"
                }
              ]
            }
            """.ReplaceLineEndings("\n"),
            flagged);
    }

    [Fact]
    public void AFlaggedRecordOfATypeItsDocumentNames_KeepsThatName()
    {
        var text = """{ "MutagenObjectType": "Npc", "FormKey": "000801:Test.esp", "Race": "000802:Test.esp" }""";

        var flagged = FlaggedDocument.For(text, ["NPC_ 00000801 — a diagnosis"], []);

        Assert.StartsWith("{\n  \"MutagenObjectType\": \"Npc\",\n  \"FormKey\": \"000801:Test.esp\",\n  \"Diagnoses\"", flagged, StringComparison.Ordinal);
    }
}
