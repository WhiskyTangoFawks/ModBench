using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;
using Fo4 = Mutagen.Bethesda.Fallout4;
using Sf = Mutagen.Bethesda.Starfield;
using Tes5 = Mutagen.Bethesda.Skyrim;

namespace MEditService.Codec.Tests.Schema;

public class TemplatedFieldTests
{
    private static readonly FormKey Slotted = FormKey.Factory("000801:Templates.esp");
    private static readonly FormKey Default = FormKey.Factory("000802:Templates.esp");

    private static Fo4.Fallout4Mod Fallout4Mod() => new(ModKey.FromFileName("Templated.esp"), Fo4.Fallout4Release.Fallout4);

    private static readonly Dictionary<string, ResolvedFormKey> Held = new(StringComparer.Ordinal)
    {
        [Slotted.ToString()] = new("npc_", "EncRaider01"),
        [Default.ToString()] = new("lvln", "LCharRaider"),
    };

    private static ResolvedFormKey? Resolve(string formKey) => Held.TryGetValue(formKey, out var held) ? held : null;

    private static IReadOnlyDictionary<string, TemplatedBy>? Templated(GameRelease release, IMajorRecordGetter npc) =>
        SharedSchemaReflector.Instance.GetSchemas(release)["npc_"]
            .TemplatedIn(Document.Parse(RecordTextCodec.SerializeToText(npc, release)), Resolve, release);

    [Fact]
    public void AFlagWithItsOwnTemplate_TemplatesTheMembersItCovers_FromThatTemplate()
    {
        var npc = new Fo4.Npc(Fallout4Mod())
        {
            UseTemplateActors = Fo4.Npc.TemplateActorType.Traits,
            TemplateActors = new Fo4.TemplateActors { TraitTemplate = new FormLink<Fo4.INpcSpawnGetter>(Slotted) },
            DefaultTemplate = new FormLinkNullable<Fo4.INpcSpawnGetter>(Default),
        };

        var race = Templated(GameRelease.Fallout4, npc).Require()["Race"];

        Assert.Equal(("Traits", Slotted.ToString(), "EncRaider01"), (race.Flag, race.Template, race.Resolution.EditorId));
    }

    [Fact]
    public void AFlagWithNoTemplateOfItsOwn_TakesTheDefaultTemplate()
    {
        var npc = new Fo4.Npc(Fallout4Mod())
        {
            UseTemplateActors = Fo4.Npc.TemplateActorType.Factions,
            DefaultTemplate = new FormLinkNullable<Fo4.INpcSpawnGetter>(Default),
        };

        var factions = Templated(GameRelease.Fallout4, npc).Require()["Factions"];

        Assert.Equal((Default.ToString(), "LCharRaider"), (factions.Template, factions.Resolution.EditorId));
    }

    [Fact]
    public void EveryFlagOfSeveralSet_TemplatesItsMembers()
    {
        var npc = new Fo4.Npc(Fallout4Mod())
        {
            // Mutagen's enum carries no [Flags], so the document spells the sum as a number.
            UseTemplateActors = (Fo4.Npc.TemplateActorType)((int)Fo4.Npc.TemplateActorType.Traits | (int)Fo4.Npc.TemplateActorType.Factions),
            DefaultTemplate = new FormLinkNullable<Fo4.INpcSpawnGetter>(Default),
        };

        var templated = Templated(GameRelease.Fallout4, npc).Require();

        Assert.Equal(("Traits", "Factions"), (templated["Race"].Flag, templated["Factions"].Flag));
    }

    [Fact]
    public void AFlagSetWithNoTemplateNamedForIt_TemplatesNothing()
    {
        var npc = new Fo4.Npc(Fallout4Mod())
        {
            UseTemplateActors = Fo4.Npc.TemplateActorType.Traits,
            TemplateActors = new Fo4.TemplateActors { StatsTemplate = new FormLink<Fo4.INpcSpawnGetter>(Slotted) },
        };

        Assert.Null(Templated(GameRelease.Fallout4, npc));
    }

    [Fact]
    public void ATemplateSpelledAsTheUnsetLink_IsNoTemplate()
    {
        var npc = new Fo4.Npc(Fallout4Mod())
        {
            UseTemplateActors = Fo4.Npc.TemplateActorType.Traits,
            TemplateActors = new Fo4.TemplateActors { StatsTemplate = new FormLink<Fo4.INpcSpawnGetter>(Slotted) },
        };
        var document = Document.Parse(RecordTextCodec.SerializeToText(npc, GameRelease.Fallout4))
            .With("Null", "TemplateActors", "TraitTemplate")
            .With("Null", "DefaultTemplate");

        Assert.Null(SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4)["npc_"].TemplatedIn(document, Resolve, GameRelease.Fallout4));
    }

    [Fact]
    public void ATemplateNamedWithItsFlagClear_TemplatesNothing()
    {
        var npc = new Fo4.Npc(Fallout4Mod())
        {
            UseTemplateActors = Fo4.Npc.TemplateActorType.Stats,
            DefaultTemplate = new FormLinkNullable<Fo4.INpcSpawnGetter>(Default),
        };

        Assert.DoesNotContain("Race", Templated(GameRelease.Fallout4, npc).Require().Keys);
    }

    [Fact]
    public void AStructMember_IsTemplatedByItsPath()
    {
        var npc = new Tes5.Npc(new Tes5.SkyrimMod(ModKey.FromFileName("Templated.esp"), Tes5.SkyrimRelease.SkyrimSE))
        {
            Configuration = new Tes5.NpcConfiguration { TemplateFlags = Tes5.NpcConfiguration.TemplateFlag.Stats },
            Template = new FormLinkNullable<Tes5.INpcSpawnGetter>(Default),
        };

        var templated = Templated(GameRelease.SkyrimSE, npc).Require();

        Assert.Equal("Stats", templated["Configuration.CalcMinLevel"].Flag);
        Assert.DoesNotContain("Configuration", templated.Keys);
    }

    [Fact]
    public void AStarfieldFlag_TemplatesFromItsOwnTemplate()
    {
        var npc = new Sf.Npc(new Sf.StarfieldMod(ModKey.FromFileName("Templated.esp"), Sf.StarfieldRelease.Starfield))
        {
            UseTemplateActors = Sf.Npc.TemplateActorType.Inventory,
            TemplateActors = new Sf.TemplateActors { InventoryTemplate = new FormLink<Sf.INpcTemplateTargetGetter>(Slotted) },
        };

        Assert.Equal(Slotted.ToString(), Templated(GameRelease.Starfield, npc).Require()["Items"].Template);
    }

    [Theory]
    [InlineData(GameRelease.Fallout4)]
    [InlineData(GameRelease.SkyrimSE)]
    [InlineData(GameRelease.Starfield)]
    public void TheTemplateFlagsAndTheirTemplates_AreNeverTemplated(GameRelease release)
    {
        var templating = SharedSchemaReflector.Instance.GetSchemas(release)["npc_"].Templating.Require();
        string[] links = [templating.FlagsMember, templating.DefaultTemplate, .. templating.Slots.Values];

        Assert.All(templating.FlagOfMember.Keys, member =>
            Assert.DoesNotContain(links, link => link == member || link.StartsWith(member + ".", StringComparison.Ordinal)));
    }
}
