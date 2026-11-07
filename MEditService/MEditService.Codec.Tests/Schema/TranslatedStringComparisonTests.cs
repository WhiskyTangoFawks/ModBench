using System.Text.Json;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using Mutagen.Bethesda.Strings;

namespace MEditService.Codec.Tests.Schema;

public sealed class TranslatedStringComparisonTests
{
    private static readonly FieldMetadata Name = new("Name", TranslatedStringValues.ApiType, false, [], []);

    private const string Localized = """
        {"TargetLanguage":"English","Values":[
            {"Language":"English","String":"Abraxo Cleaner"},
            {"Language":"French","String":"Nettoyant Abraxo"},
            {"Language":"German","String":"Abraxo-Reiniger"}]}
        """;

    private const string LocalizedWithNoPolish = """
        {"TargetLanguage":"English","Values":[{"Language":"English","String":"Other"},{"Language":"French","String":"Nettoyant Abraxo"}]}
        """;

    private static string NotLocalized(string text) => $$"""{"TargetLanguage":"English","Value":"{{text}}"}""";

    public static TheoryData<string, string, Language, bool> Pairs => new()
    {
        { NotLocalized("Abraxo Cleaner"), Localized, Language.English, true },
        { NotLocalized("Nettoyant Abraxo"), Localized, Language.French, true },
        { NotLocalized("Abraxo"), Localized, Language.English, false },
        { NotLocalized("Nettoyant Abraxo"), Localized, Language.English, false },
        { NotLocalized("Abraxo Cleaner"), Localized, Language.French, false },
        { Localized, LocalizedWithNoPolish, Language.Polish, false },
    };

    [Theory]
    [MemberData(nameof(Pairs))]
    public void ATranslatedString_IsTheSameAsAnother_OnlyWhenTheyShowOneTextInTheStringsLanguage_AsXEditComparesThem(
        string a, string b, Language stringsLanguage, bool same)
    {
        var compared = DocumentNodes.SameNode(
            JsonDocument.Parse(a).RootElement, JsonDocument.Parse(b).RootElement, Name, absentMeansDefault: true, stringsLanguage);

        Assert.Equal(same, compared);
    }
}
