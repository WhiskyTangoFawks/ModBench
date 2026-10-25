using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.RecordIndex.Tests.TestSupport;

public sealed class CompareGoldenFixture : IDisposable
{
    public PluginFixtureData Fixture { get; }
    internal OpenedIndex Index { get; }

    public static readonly FormKey ConflictedNpc = MakeKey("Base.esm", 0x800);
    public static readonly FormKey UnchangedWeapon = MakeKey("Base.esm", 0x801);
    public static readonly FormKey SoleNpc = MakeKey("Base.esm", 0x802);
    public static readonly FormKey InjectedNpc = MakeKey("Mid.esp", 0x800);
    public static readonly FormKey ConflictedRecipe = MakeKey("Base.esm", 0x803);

    private static FormKey MakeKey(string plugin, uint id) => new(ModKey.FromFileName(plugin), id);

    public CompareGoldenFixture()
    {
        Fixture = new PluginFixtureBuilder("compare-golden")
            .WithPlugin("Base.esm", mod =>
            {
                var npc = mod.Npcs.AddNew("ConflictedNPC");
                npc.Name = "Base name";
                npc.CalculatedHealth = 100;
                npc.Race.SetTo(MakeKey("Base.esm", 0x900));

                var weapon = mod.Weapons.AddNew("UnchangedWeapon");
                weapon.Value = 25;
                weapon.Weight = 2.5f;

                var lonely = mod.Npcs.AddNew("SoleNPC");
                lonely.CalculatedHealth = 7;

                var recipe = mod.ConstructibleObjects.AddNew("ConflictedRecipe");
                recipe.Conditions.Add(new ConditionFloat
                {
                    CompareOperator = CompareOperator.EqualTo,
                    ComparisonValue = 1f,
                    Flags = Condition.Flag.OR,
                    Data = new FunctionConditionData { Function = Condition.Function.GetIsID },
                });
            })
            .WithPlugin("Mid.esp", (mod, built) =>
            {
                var basePlugin = built.Single(m => m.ModKey.FileName == "Base.esm");
                mod.ModHeader.MasterReferences.Add(new MasterReference { Master = ModKey.FromFileName("Base.esm") });

                var changingTwoFields = basePlugin.Npcs.First(n => n.FormKey == ConflictedNpc).DeepCopy();
                changingTwoFields.Name = "Mid name";
                changingTwoFields.CalculatedHealth = 250;
                mod.Npcs.Set(changingTwoFields);

                var identicalToMaster = basePlugin.Weapons.First(w => w.FormKey == UnchangedWeapon).DeepCopy();
                mod.Weapons.Set(identicalToMaster);

                mod.Npcs.AddNew("InjectedNPC").Name = "Injected";
            })
            .WithPlugin("Top.esp", (mod, built) =>
            {
                var basePlugin = built.Single(m => m.ModKey.FileName == "Base.esm");
                mod.ModHeader.MasterReferences.Add(new MasterReference { Master = ModKey.FromFileName("Base.esm") });

                var disagreeingWithBothBelow = basePlugin.Npcs.First(n => n.FormKey == ConflictedNpc).DeepCopy();
                disagreeingWithBothBelow.Name = "Top name";
                disagreeingWithBothBelow.CalculatedHealth = 999;
                disagreeingWithBothBelow.Race.SetTo(MakeKey("Base.esm", 0x901));
                mod.Npcs.Set(disagreeingWithBothBelow);

                var oneConditionMemberChanged = basePlugin.ConstructibleObjects.First(c => c.FormKey == ConflictedRecipe).DeepCopy();
                oneConditionMemberChanged.Conditions[0].Data.RunOnType = Condition.RunOnType.Target;
                mod.ConstructibleObjects.Set(oneConditionMemberChanged);
            })
            .Build();
        Index = Indexes.Reconciled(Fixture);
    }

    public void Dispose()
    {
        Index.Dispose();
        Fixture.Dispose();
    }
}
