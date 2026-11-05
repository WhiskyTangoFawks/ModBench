using MEditService.LoadOrder;
using MEditService.TestSupport;
using Microsoft.Extensions.Time.Testing;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Starfield;
using static MEditService.TestSupport.RawPlugin;

namespace MEditService.PluginAdapter.Tests.PluginAdapter;

public sealed class RecordLookupFactsTests : IDisposable
{
    private const string PluginName = "Many.esp";
    private const string FirstRecord = "000800:" + PluginName;

    private readonly PluginFixtureData _data = new PluginFixtureBuilder("adapter-record-lookup-facts").WithPlugin(PluginName).Build();

    private readonly MutagenPluginAdapter _adapter = new(new FakeTimeProvider(TimeProvider.System.GetUtcNow() + TimeSpan.FromHours(1)));

    private string PluginPath => Path.Combine(_data.DataFolder, PluginName);

    public void Dispose() => _data.Dispose();

    private void Write(params byte[][] records) => File.WriteAllBytes(PluginPath, Plugin(Tes4(), Group("MISC", records)));

    private static IPluginRecords OpenIn(IPluginAdapter adapter, RegisteredPlugin plugin, LoadOrderSnapshot loadOrder) =>
        adapter.OpenRecordLookup(plugin, loadOrder, SharedSchemaReflector.Instance.GetSchemas(loadOrder.GameRelease)).Answered();

    private IPluginRecords Open() =>
        OpenIn(
            _adapter,
            new RegisteredPlugin(PluginName, PluginOrigin.DataDirectory, PluginPath, PluginProvider.Game, Line: null, PluginStrings.None),
            EmptyLoadOrder.Of(GameRelease.Fallout4));

    [Fact]
    public void ALookupOfAPluginChangedSinceTheEarlierOne_AnswersFromWhatItHolds()
    {
        Write(Misc(0x800, "First"));
        using (var earlier = Open()) Assert.Equal("First", earlier.IdentityOf(FirstRecord).Answered()?.EditorId);

        Write(Misc(0x800, "Other"));
        using var later = Open();

        Assert.Equal("Other", later.IdentityOf(FirstRecord).Answered()?.EditorId);
    }

    [Fact]
    public void ARecordTheCodecCannotRead_StillGivesItsIdentity_AndSoDoTheRecordsBesideIt()
    {
        MisshapedPerkPlugin.Plugin.WriteInto(_data.DataFolder);
        var path = Path.Combine(_data.DataFolder, MisshapedPerkPlugin.FileName);
        using var records = OpenIn(
            _adapter, new RegisteredPlugin(MisshapedPerkPlugin.FileName, PluginOrigin.DataDirectory, path, PluginProvider.Game, Line: null, PluginStrings.None),
            EmptyLoadOrder.Of(GameRelease.Fallout4));

        Assert.Equal(MisshapedPerkPlugin.EditorId, records.IdentityOf(MisshapedPerkPlugin.FormKey).Answered()?.EditorId);
        Assert.Equal("HarborReadablePerkOne", records.IdentityOf(MisshapedPerkPlugin.ReadableFormKey).Answered()?.EditorId);
    }

    [Fact]
    public void TwoRecordsOfOneKeyInTwoGroups_GiveTheIdentityOfTheOneTheTextIsOf()
    {
        File.WriteAllBytes(PluginPath, Plugin(
            Tes4(), Group("KEYM", Record("KEYM", 0x800, EditorId("AKey"))), Group("MISC", Misc(0x800, "AMisc"))));
        using var records = Open();

        var text = records.TextOf(FirstRecord).Answered();

        Assert.Contains(records.IdentityOf(FirstRecord).Answered()?.EditorId ?? "", text ?? "", StringComparison.Ordinal);
    }

    [Fact]
    public void ALookupAfterAMastersStyleChanged_AnswersAsAFreshAdapterDoes()
    {
        var loadOrder = LightMasterAndChild.LoadOrderIn(_data.DataFolder);
        var child = LightMasterAndChild.ChildIn(loadOrder);
        var weapon = LightMasterAndChild.Weapon.ToString();
        using (var earlier = OpenIn(_adapter, child, loadOrder)) Assert.NotNull(earlier.IdentityOf(weapon).Answered());
        using var freshBefore = OpenIn(TestAdapters.Mutagen(), child, loadOrder);
        var before = freshBefore.IdentityOf(weapon).Answered();

        var master = new StarfieldMod(LightMasterAndChild.Master, StarfieldRelease.Starfield);
        master.Weapons.Add(new Weapon(LightMasterAndChild.Weapon, StarfieldRelease.Starfield) { EditorID = "LightWeapon" });
        master.WriteToBinary(Path.Combine(_data.DataFolder, LightMasterAndChild.Master.FileName));
        using var later = OpenIn(_adapter, child, loadOrder);
        using var fresh = OpenIn(TestAdapters.Mutagen(), child, loadOrder);

        Assert.NotEqual(before, fresh.IdentityOf(weapon).Answered());
        Assert.Equal(fresh.IdentityOf(weapon).Answered(), later.IdentityOf(weapon).Answered());
    }
}
