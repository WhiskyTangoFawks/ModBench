using System.Text;
using MEditService.Codec.Serialization;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Codec.Tests.Serialization;

public sealed class RecordDocumentEditsTests
{
    private static readonly ModKey Old = ModKey.FromFileName("Old.esp");
    private static readonly ModKey New = ModKey.FromFileName("New.esm");

    private static string Renamed(string text, bool isHeader = false) =>
        RecordDocumentEdits.TryWithPluginRenamed(Encoding.UTF8.GetBytes(text), isHeader, Old, New, out var renamed, out var whyNot)
            ? Encoding.UTF8.GetString(renamed)
            : throw new InvalidDataException(whyNot);

    [Fact]
    public void WithPluginRenamed_FollowsEveryFormKeyOfThePlugin_AndLeavesEveryOtherByteAndKeyAlone()
    {
        const string Text = "{\r\n\t\"FormKey\":   \"000801:Old.esp\",\n  \"Name\": \"Old.esp\",\n  \"Race\": \"000802:Other.esm\",  \"Link\": \"000803:Old.esp\" }";

        Assert.Equal(
            Text.Replace("000801:Old.esp", "000801:New.esm").Replace("000803:Old.esp", "000803:New.esm"),
            Renamed(Text));
    }

    [Fact]
    public void WithPluginRenamed_ForTheHeader_FollowsItsRootModKey_ButNoOtherModKeyMember()
    {
        const string Text = """{ "ModKey": "Old.esp", "ModHeader": { "ModKey": "Old.esp" } }""";

        Assert.Equal("""{ "ModKey": "New.esm", "ModHeader": { "ModKey": "Old.esp" } }""", Renamed(Text, isHeader: true));
    }

    [Fact]
    public void WithPluginRenamed_ForARecord_LeavesAModKeyMemberAlone()
    {
        const string Text = """{ "ModKey": "Old.esp" }""";

        Assert.Equal(Text, Renamed(Text));
    }

    [Fact]
    public void WithPluginRenamed_ForTheHeader_LeavesAModKeyOfAnotherPluginAlone()
    {
        const string Text = """{ "ModKey": "Other.esp" }""";

        Assert.Equal(Text, Renamed(Text, isHeader: true));
    }

    [Theory]
    [InlineData("""{ "FormKey": "000801:Old.esp", """)]
    [InlineData("""{ "FormKey": "000801:Old.esp" } // a comment no document reader takes""")]
    public void WithPluginRenamed_TextThatIsNoJsonDocument_AnswersWhyNot(string text)
    {
        Assert.False(RecordDocumentEdits.TryWithPluginRenamed(Encoding.UTF8.GetBytes(text), false, Old, New, out _, out var whyNot));
        Assert.NotEmpty(whyNot);
    }
}
