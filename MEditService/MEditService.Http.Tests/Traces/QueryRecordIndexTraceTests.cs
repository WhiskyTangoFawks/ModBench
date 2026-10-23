using System.Net.Http.Json;
using System.Text.Json;
using MEditService.Http.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Strings;

namespace MEditService.Http.Tests.Traces;

public sealed class QueryRecordIndexTraceTests : HostedTests
{
    private ScatteredFixtureData? _localized;

    private ScatteredFixtureData Localized =>
        _localized ??= Owned(new PluginFixtureBuilder("trace-query-localized")
            .WithPlugin("Localized.esp", mod =>
            {
                mod.UsingLocalization = true;
                mod.Activators.AddNew("LocalizedLever").Name = new TranslatedString(
                    Language.English,
                    new KeyValuePair<Language, string>(Language.French, "Levier"),
                    new KeyValuePair<Language, string>(Language.English, "Lever"));
            }, origin: "LocalizedMod")
            .BuildScattered());

    private async Task LoadedLocalized(string stringsLanguage = "English") =>
        (await Client.PutLoadOrderIn(Localized, stringsLanguage)).EnsureSuccessStatusCode();

    private async Task<string?> LocalizedLeverName()
    {
        var activators = await Client.GetFromJsonAsync<JsonElement>("/records?plugin=Localized.esp&origin=LocalizedMod&type=acti&limit=10");
        return activators.GetProperty("items")[0].GetProperty("fullName").GetString();
    }

    [Fact]
    public async Task ALocalizedPluginsRecords_ShowTheirNameInTheStringsLanguageTheLoadOrderNames()
    {
        await LoadedLocalized("French");

        Assert.Equal("Levier", await LocalizedLeverName());
    }

    [Fact]
    public async Task ALocalizedName_ReadsTheSameThroughTheSqlDoor()
    {
        await LoadedLocalized();

        (await Client.PostAsJsonAsync("/load-order/filter",
            new { sql = "SELECT form_key FROM \"acti\" WHERE \"Name\" = 'Lever'", source = "lever.sql" })).EnsureSuccessStatusCode();
        var activators = await Client.GetFromJsonAsync<JsonElement>("/records?plugin=Localized.esp&origin=LocalizedMod&type=acti&limit=10");

        Assert.Equal(1, activators.GetProperty("total").GetInt32());
    }
}
