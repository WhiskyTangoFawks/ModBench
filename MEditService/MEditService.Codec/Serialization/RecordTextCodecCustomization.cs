using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Serialization.Customizations;

namespace MEditService.Codec.Serialization;

/// <summary>Filename numbering is off (ADR-0006). No Omit*Data call exists (ADR-0006): each drops real fields.</summary>
internal sealed class RecordTextCodecCustomization : ICustomize
{
    public void Customize(ICustomizationBuilder builder)
    {
        builder
            .FilePerRecord();
    }
}

/// <summary>Every write derives the masters from content (ADR-0008), so the source holds none.</summary>
internal sealed class ModHeaderMastersCustomization : ICustomize<IFallout4ModHeaderGetter>
{
    public void CustomizeFor(ICustomizationBuilder<IFallout4ModHeaderGetter> builder)
    {
        builder.Omit(x => x.MasterReferences);
    }
}

/// <summary>Every write derives the next FormID and the record count from content, so the source holds
/// neither.</summary>
internal sealed class ModStatsCustomization : ICustomize<IModStatsGetter>
{
    public void CustomizeFor(ICustomizationBuilder<IModStatsGetter> builder)
    {
        builder.Omit(x => x.NextFormID)
            .Omit(x => x.NumRecords);
    }
}
