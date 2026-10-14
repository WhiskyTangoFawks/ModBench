using Mutagen.Bethesda.Strings;

namespace MEditService.LoadOrder;

/// <summary>The language a translated text shows in, English until the extension sets another.</summary>
public sealed class StringsLanguageHolder
{
    private volatile Language _current = Language.English;

    public Language Current => _current;

    /// <summary>Raised after a change, never for a language already held.</summary>
    public event Action? Changed;

    public void Set(Language language)
    {
        if (_current == language) return;
        _current = language;
        Changed?.Invoke();
    }
}
