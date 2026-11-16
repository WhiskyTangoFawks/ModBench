using MEditService.Codec.Serialization;
using Mutagen.Bethesda.Strings;

namespace MEditService.Codec.Tests.Serialization;

public sealed class DocumentTranslatedTextTests
{
    private const string InTwoLanguages =
        """{"Name":{"TargetLanguage":"English","Values":[{"Language":"English","String":"Door"},{"Language":"French","String":"Porte"}]}}""";

    [Theory]
    [InlineData(Language.English, "Door")]
    [InlineData(Language.French, "Porte")]
    [InlineData(Language.German, null)]
    public void ATranslatedStringHoldingManyLanguages_ReadsTheOneTheLanguageShows(Language language, string? text)
    {
        Assert.Equal(text, Document.Parse(InTwoLanguages).TranslatedTextAt(language, "Name"));
    }

    [Theory]
    [InlineData("""{"Name":{"TargetLanguage":"English","Value":"Door"}}""", "Door")]
    [InlineData("""{"Name":{"TargetLanguage":"English","Value":"Door"},"Other":1}""", "Door")]
    [InlineData("""{"Other":1}""", null)]
    [InlineData("""{"Name":"Door"}""", null)]
    public void ATranslatedStringHoldingOneValue_ReadsItInAnyLanguage(string document, string? text)
    {
        Assert.Equal(text, Document.Parse(document).TranslatedTextAt(Language.French, "Name"));
    }
}
