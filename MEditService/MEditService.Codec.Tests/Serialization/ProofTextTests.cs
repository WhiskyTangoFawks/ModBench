using System.Text;
using MEditService.Codec.Serialization;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;
using Mutagen.Bethesda.Skyrim;

namespace MEditService.Codec.Tests.Serialization;

public sealed class ProofTextTests
{
    [Theory]
    [InlineData(GameRelease.Fallout4)]
    [InlineData(GameRelease.SkyrimSE)]
    [InlineData(GameRelease.Starfield)]
    public async Task TheProofText_HoldsTheMastersTheSourceLeavesOut_SinceItsSerializerHasNoCustomization(GameRelease release)
    {
        var plugin = ModFactory.Activator(ModKey.FromFileName("Proof.esp"), release);
        plugin.MasterReferences.Add(new MasterReference { Master = ModKey.FromFileName("Base.esm") });
        using var text = new MemoryStream();

        await GameCodecs.For(release).WriteProofText(plugin, text);

        Assert.Contains("Base.esm", Encoding.UTF8.GetString(text.ToArray()), StringComparison.Ordinal);
    }

    [Theory]
    [InlineData(0u)]
    [InlineData(3u)]
    public void ReadBack_HoldsAConditionsAliasIndex_AsTheSourcesReadDoes(uint index)
    {
        var recipe = AliasIndexRoundTripTests.RecipeWithAnAliasCondition(index);
        var plugin = new SkyrimMod(recipe.FormKey.ModKey, SkyrimRelease.SkyrimSE);
        plugin.ConstructibleObjects.Add(recipe);

        var read = (ISkyrimModGetter)ProofText.ReadBack(plugin);

        Assert.Equal(index, ((IGetDistanceConditionDataGetter)read.ConstructibleObjects.Single().Conditions.Single().Data).Target.Index);
    }
}
