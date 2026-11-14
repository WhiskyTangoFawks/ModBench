using MEditService.Codec.Serialization;

namespace MEditService.Codec.Tests.Serialization;

public sealed class DocumentSpansTests
{
    private const string Owner = "000700:A.esp";
    private const string Child = "000802:A.esp";
    private const string Gun = "000900:A.esp";

    private static string Spanned(string text, (int Start, int End)? span) => span is var (start, end) ? text[start..end] : "";

    [Fact]
    public void TheRecordsADocumentHolds_AreNamedByTheirCanonicalFormKeys_OutermostFirst()
    {
        const string text = """{ "FormKey": "00070a_A.esp", "Placed": [ { "FormKey": "000802:A.esp" } ], "Race": "Human" }""";

        Assert.Equal(["00070A:A.esp", Child], DocumentSpans.Read(text).RecordFormKeys);
    }

    [Theory]
    [InlineData("")]
    [InlineData("*Mid.esp\r\n*Base.esm\r\n")]
    [InlineData("]}:,")]
    public void TextThatIsNoDocument_HoldsNoRecord(string text)
    {
        Assert.Empty(DocumentSpans.Read(text).RecordFormKeys);
    }

    [Theory]
    [InlineData("at the field path that spells it", "Base", """{ "FormKey": "000700:A.esp", "Placed": [ { "FormKey": "000802:A.esp", "Other": "000900:A.esp", "Base": "000900:A.esp" } ] }""", "\"Base\": ")]
    [InlineData("first in its record where the field path spells something else", "Other", """{ "FormKey": "000700:A.esp", "Placed": [ { "FormKey": "000802:A.esp", "Base": "000900:A.esp", "Other": "Gun" } ] }""", "\"Base\": ")]
    [InlineData("first in its record, past its owner's", null, """{ "FormKey": "000700:A.esp", "Owner": "000900:A.esp", "Placed": [ { "FormKey": "000802:A.esp", "Base": "000900_A.esp" } ] }""", "\"Base\": ")]
    public void AString_IsFoundInItsRecord(string _, string? fieldPath, string text, string before)
    {
        Assert.Equal(text.IndexOf(before, StringComparison.Ordinal) + before.Length, DocumentSpans.Read(text).StringOf(Child, Gun, fieldPath)?.Start);
    }

    [Fact]
    public void AString_IsFoundAnywhere_WhereTheDocumentHoldsNoSuchRecord_AndSpansItsQuotes()
    {
        const string text = """{ "Name": "Épée 🗡", "Ref": "00090a_A.esp" }""";

        Assert.Equal("\"00090a_A.esp\"", Spanned(text, DocumentSpans.Read(text).StringOf("000999:A.esp", "00090A:A.esp", null)));
    }

    [Fact]
    public void AStringNoDocumentSpells_IsNowhere()
    {
        Assert.Null(DocumentSpans.Read($$"""{ "FormKey": "{{Owner}}" }""").StringOf(Owner, Gun, null));
    }
}
