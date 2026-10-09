using System.Text;
using System.Text.Json;
using MEditService.Codec.Serialization;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Codec.Tests.Serialization;

public sealed class PluginRenameDocumentTests
{
    private static readonly ModKey Old = ModKey.FromFileName("Old.esp");
    private static readonly ModKey New = ModKey.FromFileName("New.esm");

    private static string Renamed(string text, bool isHeader = false) =>
        Encoding.UTF8.GetString(RecordDocumentEdits.WithPluginRenamed(Encoding.UTF8.GetBytes(text), isHeader, Old, New));

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

    [Fact]
    public void WithPluginRenamed_TextThatIsNoJsonDocument_Throws()
    {
        Assert.ThrowsAny<JsonException>(() => Renamed("""{ "FormKey": "000801:Old.esp", """));
    }
}
