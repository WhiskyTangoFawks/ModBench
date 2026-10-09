using System.Text.Json;
using MEditService.Codec.Serialization;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;
using Noggog;

namespace MEditService.Codec.Tests.Serialization;

public sealed class ContainerDocumentEditsTests
{
    private const GameRelease Release = GameRelease.Fallout4;

    private static string Text(IMajorRecordGetter record) => RecordTextCodec.SerializeToText(record, Release);

    private static string RecordTypeOf(IMajorRecordGetter record) => RecordTypes.For(Release).RecordTypeOf(record);

    private static FormKey Key(string id) => FormKey.Factory($"{id}:Append.esp");

    private static ChildAppend Appended(string containerText, string containerRecordType, string slot, IMajorRecordGetter child) =>
        ContainerDocumentEdits.WithChildAppended(containerText, Release, containerRecordType, slot, Text(child), RecordTypeOf(child));

    private static ChildAppend Appended(Worldspace worldspace, Cell cell) => Appended(Text(worldspace), RecordTypeOf(worldspace), "TopCell", cell);

    [Fact]
    public void AppendingToAWorldspacesPersistentCell_WhenItHoldsNone_SetsIt()
    {
        var mod = new Fallout4Mod(ModKey.FromFileName("Append.esp"), Fallout4Release.Fallout4);
        var worldspace = new Worldspace(mod) { EditorID = "World" };
        var cell = new Cell(mod) { EditorID = "Persistent" };

        Assert.Contains(cell.FormKey.ToString(), Assert.IsType<ChildAppend.Appended>(Appended(worldspace, cell)).Text, StringComparison.Ordinal);
    }

    [Fact]
    public void AppendingToAWorldspacesPersistentCell_WhenItHoldsOne_AnswersTheSlotHeld_NamingItsHolder()
    {
        var mod = new Fallout4Mod(ModKey.FromFileName("Append.esp"), Fallout4Release.Fallout4);
        var held = new Cell(mod) { EditorID = "Held" };
        var worldspace = new Worldspace(mod) { EditorID = "World", TopCell = held };
        var other = new Cell(mod) { EditorID = "Other" };

        Assert.Equal(new ChildAppend.SlotHeld("TopCell", held.FormKey.ToString()), Appended(worldspace, other));
    }

    [Fact]
    public void AppendingToAList_OfHandFormattedText_InsertsTheChildAtItsEnd_AndChangesNoOtherByte()
    {
        const string handFormatted = """
            {
                "FormKey": "000800:Append.esp",
                "Responses": [
                    {
                        "FormKey": "000801:Append.esp",
                        "EditorID":   "R1"
                    }
                ],
                "EditorID":"Topic"
            }
            """;
        var added = new DialogResponses(Key("000802"), Fallout4Release.Fallout4) { EditorID = "R2" };
        var expected = new DialogTopic(Key("000800"), Fallout4Release.Fallout4) { EditorID = "Topic" };
        expected.Responses.Add(new DialogResponses(Key("000801"), Fallout4Release.Fallout4) { EditorID = "R1" });
        expected.Responses.Add(added);

        var edited = Assert.IsType<ChildAppend.Appended>(Appended(handFormatted, RecordTypeOf(expected), "Responses", added)).Text;

        OneInsertion.AssertKeepsEveryOtherByte(handFormatted, edited);
        Assert.Equal(Text(expected), RecordTextCodec.RoundTrip(edited, Release, RecordTypeOf(expected)));
    }

    [Fact]
    public void AppendingToAListTheTextSpellsEmpty_FillsIt_AndChangesNoOtherByte()
    {
        const string handFormatted = """
            {
                "FormKey": "000820:Append.esp",
                "EditorID": "Topic",
                "Responses": []
            }
            """;
        var added = new DialogResponses(Key("000821"), Fallout4Release.Fallout4) { EditorID = "R1" };
        var expected = new DialogTopic(Key("000820"), Fallout4Release.Fallout4) { EditorID = "Topic" };
        expected.Responses.Add(added);

        var edited = Assert.IsType<ChildAppend.Appended>(Appended(handFormatted, RecordTypeOf(expected), "Responses", added)).Text;

        OneInsertion.AssertKeepsEveryOtherByte(handFormatted, edited);
        using var document = JsonDocument.Parse(edited);
        Assert.Single(document.RootElement.EnumerateObject(), member => member.Name == "Responses");
        Assert.Equal(Text(expected), RecordTextCodec.RoundTrip(edited, Release, RecordTypeOf(expected)));
    }

    [Fact]
    public void AppendingToASlotTheTextLacks_OfHandFormattedText_AddsTheSlotWithTheChild_AndChangesNoOtherByte()
    {
        const string handFormatted = """
            {
                "FormKey":   "000810:Append.esp",
                "WaterHeight": 100.0,
                "EditorID": "Interior"
            }
            """;
        var added = new PlacedObject(Key("000811"), Fallout4Release.Fallout4) { EditorID = "Placed", Position = new P3Float(1f, 2f, 3f) };
        var expected = new Cell(Key("000810"), Fallout4Release.Fallout4) { EditorID = "Interior", WaterHeight = 100f };
        expected.Temporary.Add(added);

        var edited = Assert.IsType<ChildAppend.Appended>(Appended(handFormatted, RecordTypeOf(expected), "Temporary", added)).Text;

        OneInsertion.AssertKeepsEveryOtherByte(handFormatted, edited);
        Assert.Equal(Text(expected), RecordTextCodec.RoundTrip(edited, Release, RecordTypeOf(expected)));
    }
}
