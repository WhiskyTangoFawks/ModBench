using System.Text.Json;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using Mutagen.Bethesda.Strings;

namespace MEditService.Codec.Tests.Schema;

public sealed class TranslatedStringSameNodeTests
{
    private static readonly FieldMetadata Name = new("Name", TranslatedStringValues.ApiType, false, [], []);

    private const string Localized = """
        {"TargetLanguage":"English","Values":[
            {"Language":"English","String":"Abraxo Cleaner"},
            {"Language":"French","String":"Nettoyant Abraxo"},
            {"Language":"German","String":"Abraxo-Reiniger"}]}
        """;

    private static bool Same(string a, string b, Language language) =>
        DocumentNodes.SameNode(JsonDocument.Parse(a).RootElement, JsonDocument.Parse(b).RootElement, Name, absentMeansDefault: true, language);

    [Fact]
    public void AStringNotLocalized_IsTheSameAsALocalizedOne_HoldingItsTextInTheStringsLanguage_AsXEditReadsThem()
    {
        Assert.True(Same("""{"TargetLanguage":"English","Value":"Abraxo Cleaner"}""", Localized, Language.English));
        Assert.True(Same("""{"TargetLanguage":"English","Value":"Nettoyant Abraxo"}""", Localized, Language.French));
    }

    [Theory]
    [InlineData("Abraxo", "English")]
    [InlineData("Nettoyant Abraxo", "English")]
    [InlineData("Abraxo Cleaner", "French")]
    public void AStringNotLocalized_DiffersFromALocalizedOne_WhoseTextInTheStringsLanguageIsAnother(string text, string language)
    {
        Assert.False(Same($$"""{"TargetLanguage":"English","Value":"{{text}}"}""", Localized, Enum.Parse<Language>(language)));
    }

    [Fact]
    public void LocalizedStringsWithNoTextInTheStringsLanguage_AreComparedByEveryTextTheyHold()
    {
        const string other = """{"TargetLanguage":"English","Values":[{"Language":"English","String":"Other"},{"Language":"French","String":"Nettoyant Abraxo"}]}""";

        Assert.False(Same(Localized, other, Language.Polish));
    }
}
