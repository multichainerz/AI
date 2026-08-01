UPDATE "OnboardingJourney"
SET "currentStepKey" = 'activate-installation'
WHERE "currentStepKey" = 'claim-installation';

UPDATE "OnboardingStep"
SET "key" = 'activate-installation',
    "title" = 'Activate installation',
    "description" = 'Confirm the permanent Installation Key, installed release, and host identity.'
WHERE "key" = 'claim-installation';

UPDATE "AdministratorSession"
SET "subject" = 'installation-key-administrator'
WHERE "subject" = 'bootstrap-administrator';
