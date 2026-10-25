using MEditService.Codec.Serialization;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Skyrim;
using Noggog.WorkEngine;

namespace MEditService.Codec.Tests.Serialization;

public sealed class AliasIndexRoundTripTests
{
    internal static ConstructibleObject RecipeWithAnAliasCondition(uint index)
    {
        var recipe = new ConstructibleObject(new FormKey(ModKey.FromFileName("Test.esp"), 0x800), SkyrimRelease.SkyrimSE) { EditorID = "Recipe" };
        var data = new GetDistanceConditionData { UseAliases = true };
        data.Target.Index = index;
        recipe.Conditions.Add(new ConditionFloat { Data = data });
        return recipe;
    }

    [Theory]
    [InlineData(0u)]
    [InlineData(3u)]
    public async Task TheWholeModDoor_ReadsBackAConditionsAliasIndex(uint index)
    {
        var recipe = RecipeWithAnAliasCondition(index);
        var mod = new SkyrimMod(recipe.FormKey.ModKey, SkyrimRelease.SkyrimSE);
        mod.ConstructibleObjects.Add(recipe);
        using var folder = new ScratchDirectory("medit-alias-index-");
        var codec = GameCodecs.For(GameRelease.SkyrimSE);

        await codec.SerializeWholeMod(mod, folder.Path, InlineWorkDropoff.Instance, CancellationToken.None);
        var read = (ISkyrimModGetter)await codec.DeserializeWholeMod(folder.Path, InlineWorkDropoff.Instance, CancellationToken.None);

        var data = (IGetDistanceConditionDataGetter)read.ConstructibleObjects.Single().Conditions.Single().Data;
        Assert.Equal(index, data.Target.Index);
    }
}
