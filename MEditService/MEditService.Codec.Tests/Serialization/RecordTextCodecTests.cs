using System.Text;
using System.Text.Json;
using MEditService.Codec.Serialization;
using MEditService.Codec.Tests.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Strings;
using Noggog;

namespace MEditService.Codec.Tests.Serialization;

public class RecordTextCodecTests
{
    private static Weapon MakeWeapon() =>
        new(new FormKey(ModKey.FromFileName("Test.esp"), 0x800), Fallout4Release.Fallout4)
        {
            VersionControl = 12345,
            EditorID = "TestWeapon",
            Name = "Test Weapon Name",
            Value = 250,
            Weight = 12.5f,
            BaseDamage = 42,
            Keywords = [new FormLink<IKeywordGetter>(new FormKey(ModKey.FromFileName("Test.esp"), 0x801))],
            ObjectBounds = new ObjectBounds
            {
                First = new P3Int16(1, 2, 3),
                Second = new P3Int16(4, 5, 6),
            },
        };

    [Fact]
    public void RoundTrip_GivesAWeaponsTextBackUnchanged_SoTheGoldenBytesBelowPinWhatAReadKeeps()
    {
        var text = RecordTextCodec.SerializeToText(MakeWeapon(), GameRelease.Fallout4);

        Assert.Equal(text, RecordTextCodec.RoundTrip(text, GameRelease.Fallout4, "weap"));
    }

    [Fact]
    public async Task AWeapon_ReadsBackFieldFaithful_BecauseTheOmitCustomizationsAreVerifiedNoOpsForAStandaloneWeaponBothTargetingOnlyGroupCellWorldspaceFieldsItDoesNotHave()
    {
        var original = MakeWeapon();
        var mod = new Fallout4Mod(original.FormKey.ModKey, Fallout4Release.Fallout4);
        mod.Weapons.Add(original);

        var readBack = await ReadBack.ThroughTheWholeModDoor<IWeaponGetter>(mod, original);

        var leaves = MaskInspector.CountLeaves(original.GetEqualsMask(readBack)).ToList();
        Assert.Equal(81, leaves.Count);
        Assert.Empty(leaves.Where(l => !l.Value).Select(l => l.Path));
    }

    [Fact]
    public async Task SerializeToText_ForAFixedWeapon_ProducesThePinnedGoldenBytes()
    {
        var actual = Encoding.UTF8.GetBytes(RecordTextCodec.SerializeToText(MakeWeapon(), GameRelease.Fallout4));

        var golden = await File.ReadAllBytesAsync(
            Path.Combine(AppContext.BaseDirectory, "TestData", "weapon-dispatch-golden.json"));
        Assert.Equal(golden, actual);
    }

    [Fact]
    public void SerializeToText_CalledTwiceOnTheSameRecordState_ProducesIdenticalText_WithNoGoldenInTheLoopBecauseAGoldenIsBlindToNonDeterminismThatReproducesTheSameWrongOutputEveryRun()
    {
        var independentlyConstructedSecondWeaponSoAPerInstanceMemoizerCannotTriviallyAgreeWithItself = MakeWeapon();

        var firstText = RecordTextCodec.SerializeToText(MakeWeapon(), GameRelease.Fallout4);
        var secondText = RecordTextCodec.SerializeToText(independentlyConstructedSecondWeaponSoAPerInstanceMemoizerCannotTriviallyAgreeWithItself, GameRelease.Fallout4);

        Assert.Equal(firstText, secondText);
    }

    [Fact]
    public void SerializeToText_NeverEmitsACarriageReturn_BecauseTheJsonKernelIndentsFromItsPrivateInnerTextWritersNewLineWhichTheCodecCannotConfigureSoItNormalizesAfter()
    {
        var text = RecordTextCodec.SerializeToText(MakeWeapon(), GameRelease.Fallout4);

        Assert.DoesNotContain('\r', text);
    }

    [Fact]
    public void InLanguage_ATranslatedStringNestedInARecord_BecomesItsStringsLanguageValueAsDoesTheRecordsOwn()
    {
        var weapon = MakeWeapon();
        weapon.Name = new TranslatedString(Language.English,
        [
            new KeyValuePair<Language, string>(Language.English, "Weapon"),
            new KeyValuePair<Language, string>(Language.French, "Arme"),
        ]);
        weapon.ObjectTemplates =
        [
            new ObjectTemplate<Weapon.Property>
            {
                Name = new TranslatedString(Language.English,
                [
                    new KeyValuePair<Language, string>(Language.English, "Mod English"),
                    new KeyValuePair<Language, string>(Language.French, "Modele"),
                ]),
            },
        ];
        var text = RecordTextCodec.SerializeToText(weapon, GameRelease.Fallout4);

        var collapsed = TranslatedStringValues.InLanguage(text, Language.French, GameRelease.Fallout4, "WEAP").Text;

        Assert.Contains("\"Values\"", text, StringComparison.Ordinal);
        Assert.DoesNotContain("\"Values\"", collapsed, StringComparison.Ordinal);
        Assert.Contains("Arme", collapsed, StringComparison.Ordinal);
        Assert.Contains("Modele", collapsed, StringComparison.Ordinal);
        Assert.DoesNotContain("Mod English", collapsed, StringComparison.Ordinal);
    }

    [Fact]
    public void InLanguage_AStringWithNoTextInTheLanguage_ReportsItsPathAndLeavesIt()
    {
        var weapon = MakeWeapon();
        weapon.Name = new TranslatedString(Language.English,
        [
            new KeyValuePair<Language, string>(Language.English, "Weapon"),
            new KeyValuePair<Language, string>(Language.German, "Waffe"),
        ]);
        weapon.ObjectTemplates =
        [
            new ObjectTemplate<Weapon.Property>
            {
                Name = new TranslatedString(Language.English,
                [
                    new KeyValuePair<Language, string>(Language.English, "Mod English"),
                    new KeyValuePair<Language, string>(Language.French, "Modele"),
                ]),
            },
        ];
        var text = RecordTextCodec.SerializeToText(weapon, GameRelease.Fallout4);

        var collapsed = TranslatedStringValues.InLanguage(text, Language.French, GameRelease.Fallout4, "WEAP");

        Assert.Equal(["Name"], collapsed.Unresolved);
        Assert.Contains("Weapon", collapsed.Text, StringComparison.Ordinal);
        Assert.Contains("Modele", collapsed.Text, StringComparison.Ordinal);
    }

    [Fact]
    public void SerializeToText_ATranslatedStringsLanguages_ListInLanguageOrderWhateverOrderTheModelHoldsThem()
    {
        var weapon = MakeWeapon();
        weapon.Name = new TranslatedString(Language.English,
        [
            new KeyValuePair<Language, string>(Language.French, "Arme"),
            new KeyValuePair<Language, string>(Language.English, "Weapon"),
            new KeyValuePair<Language, string>(Language.German, "Waffe"),
        ]);

        using var doc = JsonDocument.Parse(RecordTextCodec.SerializeToText(weapon, GameRelease.Fallout4));

        Assert.Equal(
            ["English", "German", "French"],
            doc.RootElement.GetProperty("Name").GetProperty("Values").EnumerateArray().Select(value => value.GetProperty("Language").GetString()));
    }
}
